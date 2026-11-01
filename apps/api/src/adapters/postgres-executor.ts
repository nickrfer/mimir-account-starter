import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { postgresTypes } from './postgres.js';
import { LeaseLostError } from '../ports/executor.js';
import type { ExecutorPort, FailureOutcome, OperationClaim, PublishedPackage } from '../ports/executor.js';
import type { CapturedPayload } from '../ports/deliveries.js';

const LEASE = `clock_timestamp() + interval '30 seconds'`;
const OWNED = `o.workspace_id=$1 AND o.id=$2 AND o.status='EM_PROCESSAMENTO' AND o.fencing_token=$3 AND o.lease_holder=$4 AND o.lease_expires_at>clock_timestamp()`;
const ownership = (claim: OperationClaim) => [claim.workspaceId, claim.operationId, claim.token, claim.holder];

export class PostgresExecutor implements ExecutorPort {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string, private readonly scope?: ReadonlySet<string>) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 3, types: postgresTypes, application_name: 'mimir-executor',
      connectionTimeoutMillis: 1500, query_timeout: 60000, idleTimeoutMillis: 10000, options: '-c statement_timeout=60000 -c search_path=mimir,pg_catalog' });
    this.pool.on('error', () => {});
  }

  private async transaction<T>(action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }

  claimNextOperation(holder: string): Promise<OperationClaim | null> {
    return this.transaction(async client => {
      const scope = this.scope ? [...this.scope] : null;
      await client.query(`UPDATE mimir.delivery_operations SET status='FALHA', error_code='ATTEMPTS_EXHAUSTED', lease_holder=NULL, lease_expires_at=NULL,
        next_retry_at=NULL, completed_at=clock_timestamp()
        WHERE id IN (SELECT id FROM mimir.delivery_operations WHERE status='EM_PROCESSAMENTO' AND attempt_count>=3 AND lease_expires_at<=clock_timestamp()
          AND ($1::uuid[] IS NULL OR workspace_id = ANY($1)) ORDER BY created_at, id LIMIT 50 FOR UPDATE SKIP LOCKED)`, [scope]);
      const row = (await client.query<{ id: string; workspace_id: string; snapshot_id: string; fencing_token: number; attempt_count: number }>(
        `UPDATE mimir.delivery_operations o SET status='EM_PROCESSAMENTO', attempt_count=o.attempt_count+1, fencing_token=o.fencing_token+1,
           lease_holder=$1, lease_expires_at=${LEASE}, next_retry_at=NULL
         FROM (SELECT id FROM mimir.delivery_operations WHERE attempt_count<3 AND (
             (status='EM_FILA' AND coalesce(next_retry_at,'-infinity')<=clock_timestamp())
             OR (status='EM_PROCESSAMENTO' AND lease_expires_at<=clock_timestamp()))
             AND ($2::uuid[] IS NULL OR workspace_id = ANY($2))
           ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) c
         WHERE o.id=c.id RETURNING o.id,o.workspace_id,o.snapshot_id,o.fencing_token,o.attempt_count`, [holder, scope])).rows[0];
      return row ? { operationId: row.id, workspaceId: row.workspace_id, snapshotId: row.snapshot_id, token: row.fencing_token, attempt: row.attempt_count, holder } : null;
    });
  }

  async renewLease(claim: OperationClaim): Promise<boolean> {
    return this.transaction(async client => (await client.query(`UPDATE mimir.delivery_operations o SET lease_expires_at=${LEASE} WHERE ${OWNED}`, ownership(claim))).rowCount === 1);
  }

  async readSnapshot(claim: OperationClaim): Promise<CapturedPayload> {
    const row = (await this.pool.query<{ payload: CapturedPayload }>(`SELECT s.payload FROM mimir.delivery_operations o
      JOIN mimir.delivery_snapshots s ON (s.workspace_id,s.id,s.operation_id)=(o.workspace_id,o.snapshot_id,o.id)
      WHERE ${OWNED} AND o.snapshot_id=$5`, [...ownership(claim), claim.snapshotId])).rows[0];
    if (!row) throw new LeaseLostError();
    return row.payload;
  }

  async readCapturedDocument(claim: OperationClaim, documentId: string): Promise<Buffer> {
    const row = (await this.pool.query<{ bytes: Buffer }>(`SELECT d.bytes FROM mimir.delivery_operations o
      JOIN mimir.snapshot_documents sd ON (sd.workspace_id,sd.snapshot_id)=(o.workspace_id,o.snapshot_id)
      JOIN mimir.documents d ON (d.workspace_id,d.id)=(sd.workspace_id,sd.document_id)
      WHERE ${OWNED} AND sd.document_id=$5`, [...ownership(claim), documentId])).rows[0];
    if (!row) throw new LeaseLostError();
    return row.bytes;
  }

  publishPackage(claim: OperationClaim, published: PublishedPackage): Promise<boolean> {
    return this.transaction(async client => {
      const locked = await client.query(`SELECT 1 FROM mimir.delivery_operations o WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE`, [claim.workspaceId, claim.operationId]);
      if (!locked.rowCount) return false;
      const owned = await client.query(`SELECT 1 FROM mimir.delivery_operations o WHERE ${OWNED}`, ownership(claim));
      if (!owned.rowCount) return false;
      await client.query(`INSERT INTO mimir.delivery_packages(id,workspace_id,snapshot_id,operation_id,zip_bytes,zip_size,zip_hash,manifest_bytes,manifest_hash,published_token)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [randomUUID(), claim.workspaceId, claim.snapshotId, claim.operationId, published.zip, published.zip.length,
        published.zipHash, published.manifest, published.manifestHash, claim.token]);
      await client.query(`UPDATE mimir.delivery_operations SET status='PRONTA', lease_holder=NULL, lease_expires_at=NULL, next_retry_at=NULL,
        error_code=NULL, completed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`, [claim.workspaceId, claim.operationId]);
      return true;
    });
  }

  handleAttemptFailure(claim: OperationClaim, errorCode: string): Promise<FailureOutcome> {
    return this.transaction(async (client): Promise<FailureOutcome> => {
      const locked = await client.query(`SELECT 1 FROM mimir.delivery_operations o WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE`, [claim.workspaceId, claim.operationId]);
      if (!locked.rowCount) return 'LOST';
      const owned = await client.query<{ attempt_count: number }>(`SELECT o.attempt_count FROM mimir.delivery_operations o WHERE ${OWNED}`, ownership(claim));
      const attempt = owned.rows[0]?.attempt_count;
      if (attempt === undefined) return 'LOST';
      if (attempt < 3) {
        await client.query(`UPDATE mimir.delivery_operations SET status='EM_FILA', lease_holder=NULL, lease_expires_at=NULL,
          next_retry_at=clock_timestamp() + ($3 * interval '1 second') WHERE workspace_id=$1 AND id=$2`, [claim.workspaceId, claim.operationId, attempt === 1 ? 2 : 5]);
        return 'RESCHEDULED';
      }
      await client.query(`UPDATE mimir.delivery_operations SET status='FALHA', error_code=$3, lease_holder=NULL, lease_expires_at=NULL,
        next_retry_at=NULL, completed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`, [claim.workspaceId, claim.operationId, errorCode]);
      return 'FAILED';
    });
  }

  async close(): Promise<void> { await this.pool.end(); }
}
