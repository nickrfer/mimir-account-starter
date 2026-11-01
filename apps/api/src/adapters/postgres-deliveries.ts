import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { postgresTypes } from './postgres.js';
import { authorizeActor, lockWorkspace } from './postgres-workspace.js';
import { selectPeriod } from './postgres-period-selection.js';
import { captureFingerprint, captureInput, idempotencyKey, operationId } from '../deliveries/input.js';
import { previewMonth } from '../preview/http.js';
import { ApiError } from '../http/error.js';
import type { WorkspaceActor } from '../ports/workspace.js';
import type { CaptureCommand, CapturedPayload, DeliveriesPort, DeliveryOperation, DeliveryPage, PublishedFile } from '../ports/deliveries.js';

interface OperationRow {
  id: string; snapshot_id: string; period_month: string; version_number: number; captured_revision: number;
  status: DeliveryOperation['status']; attempt_count: number; error_code: string | null; created_at: Date; completed_at: Date | null;
}
const operationColumns = `o.id,o.snapshot_id,s.period_month,s.version_number,s.captured_revision,o.status,o.attempt_count,o.error_code,o.created_at,o.completed_at`;
const operationTables = `mimir.delivery_operations o JOIN mimir.delivery_snapshots s ON (s.workspace_id,s.id,s.operation_id)=(o.workspace_id,o.snapshot_id,o.id)`;
function operation(row: OperationRow): DeliveryOperation {
  return { id: row.id, snapshotId: row.snapshot_id, periodMonth: row.period_month, versionNumber: row.version_number,
    capturedRevision: row.captured_revision, status: row.status, attemptCount: row.attempt_count, errorCode: row.error_code,
    createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null };
}
function notFound(): never { throw new ApiError(404, 'NOT_FOUND', 'Objeto não encontrado'); }

export class PostgresDeliveries implements DeliveriesPort {
  private readonly pool: pg.Pool;
  private readonly bulk: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4, types: postgresTypes, application_name: 'mimir-deliveries',
      connectionTimeoutMillis: 1500, query_timeout: 5000, idleTimeoutMillis: 10000, options: '-c statement_timeout=5000 -c search_path=mimir,pg_catalog' });
    this.pool.on('error', () => {});
    this.bulk = new pg.Pool({ connectionString: databaseUrl, max: 2, types: postgresTypes, application_name: 'mimir-downloads',
      connectionTimeoutMillis: 1500, query_timeout: 60000, idleTimeoutMillis: 10000, options: '-c statement_timeout=60000 -c search_path=mimir,pg_catalog' });
    this.bulk.on('error', () => {});
  }
  async captureDelivery(actor: WorkspaceActor, input: CaptureCommand, rawKey: string): Promise<{ operation: DeliveryOperation; status: 200 | 202 }> {
    const command = captureInput(input), key = idempotencyKey(rawKey), fingerprint = captureFingerprint(command);
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const revision = await lockWorkspace(client, actor);
      const existing = (await client.query<OperationRow & { request_fingerprint: string }>(`SELECT ${operationColumns},k.request_fingerprint
        FROM mimir.idempotency_keys k JOIN mimir.delivery_operations o ON (o.workspace_id,o.id)=(k.workspace_id,k.operation_id)
        JOIN mimir.delivery_snapshots s ON (s.workspace_id,s.id,s.operation_id)=(o.workspace_id,o.snapshot_id,o.id)
        WHERE k.workspace_id=$1 AND k.key=$2`, [actor.workspaceId, key])).rows[0];
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Chave usada com outro comando');
        await authorizeActor(client, actor);
        await client.query('COMMIT');
        return { operation: operation(existing), status: existing.status === 'PRONTA' || existing.status === 'FALHA' ? 200 : 202 };
      }
      if (revision !== command.expectedRevision) throw new ApiError(409, 'REVISION_CONFLICT', 'Revisão desatualizada');
      const selection = await selectPeriod(client, actor, command.periodMonth), preview = selection.preview;
      if (!preview.transactions.length) throw new ApiError(422, 'EMPTY_PERIOD', 'Período sem movimentações');
      const previous = (await client.query<{ version: number }>('SELECT coalesce(max(version_number),0) AS version FROM mimir.delivery_snapshots WHERE workspace_id=$1 AND period_month=$2', [actor.workspaceId, command.periodMonth])).rows[0]!.version;
      if (previous === 2147483647) throw new ApiError(409, 'VERSION_EXHAUSTED', 'Limite de versões atingido');
      if (previous > 0 && [...command.rectificationReason].length < 3) throw new ApiError(422, 'RECTIFICATION_REASON_REQUIRED', 'Nova versão exige motivo de retificação');
      const snapshotId = randomUUID(), id = randomUUID(), versionNumber = previous + 1;
      // Millisecond precision keeps the stored timestamp identical to its JSON RFC3339 representation.
      const capturedAt = (await client.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0]!.now.toISOString();
      const payload: CapturedPayload = { schemaVersion: 'mimir.snapshot.v1', workspace: preview.workspace,
        delivery: { snapshotId, operationId: id, periodMonth: command.periodMonth, versionNumber, capturedRevision: revision, rectificationReason: command.rectificationReason, capturedAt },
        summary: preview.summary, transactions: preview.transactions, contextTransactions: preview.contextTransactions,
        reimbursementLinks: preview.reimbursementLinks, pendingItems: preview.pendingItems, documents: selection.documents, period: selection.period };
      const json = JSON.stringify(payload);
      if (Buffer.byteLength(json, 'utf8') > 8 * 1024 * 1024) throw new ApiError(413, 'SNAPSHOT_TOO_LARGE', 'Snapshot excede o limite');
      const payloadBytes = (await client.query<{ size: number }>("SELECT octet_length(convert_to($1::jsonb::text,'UTF8')) AS size", [json])).rows[0]!.size;
      if (payloadBytes > 8 * 1024 * 1024) throw new ApiError(413, 'SNAPSHOT_TOO_LARGE', 'Snapshot excede o limite');
      const documentBytes = selection.documents.reduce((sum, document) => sum + document.sizeBytes, 0);
      await client.query(`INSERT INTO mimir.delivery_snapshots(id,workspace_id,operation_id,period_month,version_number,captured_revision,rectification_reason,captured_at,payload,transaction_count,document_count,document_bytes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`, [snapshotId,actor.workspaceId,id,command.periodMonth,versionNumber,revision,command.rectificationReason,capturedAt,json,
        preview.transactions.length + preview.contextTransactions.length,selection.documents.length,documentBytes]);
      if (selection.documents.length) await client.query(`INSERT INTO mimir.snapshot_documents(workspace_id,snapshot_id,document_id)
        SELECT $1::uuid,$2::uuid,unnest($3::uuid[])`, [actor.workspaceId,snapshotId,selection.documents.map(document => document.documentId)]);
      await client.query(`INSERT INTO mimir.delivery_operations(id,workspace_id,snapshot_id,status,attempt_count,fencing_token,created_at,next_retry_at)
        VALUES($1,$2,$3,'EM_FILA',0,0,$4,$4)`, [id,actor.workspaceId,snapshotId,capturedAt]);
      await client.query('INSERT INTO mimir.idempotency_keys(workspace_id,key,request_fingerprint,operation_id) VALUES($1,$2,$3,$4)', [actor.workspaceId,key,fingerprint,id]);
      await authorizeActor(client, actor);
      await client.query('COMMIT');
      return { operation: { id,snapshotId,periodMonth: command.periodMonth,versionNumber,capturedRevision: revision,status: 'EM_FILA',attemptCount: 0,errorCode: null,createdAt: capturedAt,completedAt: null }, status: 202 };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }
  async getOperation(actor: WorkspaceActor, rawId: string): Promise<DeliveryOperation> {
    const id = operationId(rawId), client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await authorizeActor(client, actor);
      const row = (await client.query<OperationRow>(`SELECT ${operationColumns} FROM ${operationTables} WHERE o.workspace_id=$1 AND o.id=$2`, [actor.workspaceId,id])).rows[0];
      if (!row) notFound();
      await authorizeActor(client, actor); await client.query('COMMIT'); return operation(row);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; } throw error;
    } finally { client.release(broken); }
  }
  async listDeliveries(actor: WorkspaceActor, rawMonth: string, page: DeliveryPage): Promise<{ items: DeliveryOperation[]; nextCursor: string | null }> {
    const month = previewMonth(rawMonth), cursor = page.cursor ? operationId(page.cursor) : null;
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 200) throw new ApiError(400, 'INVALID_QUERY', 'Paginação inválida');
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await authorizeActor(client, actor);
      let version = 0;
      if (cursor) {
        const anchor = (await client.query<{ version_number: number }>(`SELECT s.version_number FROM ${operationTables} WHERE o.workspace_id=$1 AND o.id=$2 AND s.period_month=$3`, [actor.workspaceId,cursor,month])).rows[0];
        if (!anchor) notFound(); version = anchor.version_number;
      }
      const rows = (await client.query<OperationRow>(`SELECT ${operationColumns} FROM ${operationTables}
        WHERE o.workspace_id=$1 AND s.period_month=$2 AND s.version_number>$3 ORDER BY s.version_number LIMIT $4`, [actor.workspaceId,month,version,page.limit+1])).rows;
      const items = rows.slice(0,page.limit).map(operation), nextCursor = rows.length > page.limit ? items.at(-1)!.id : null;
      await authorizeActor(client, actor); await client.query('COMMIT'); return { items,nextCursor };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; } throw error;
    } finally { client.release(broken); }
  }
  async readPublishedFile(actor: WorkspaceActor, rawId: string, kind: 'package' | 'manifest'): Promise<PublishedFile> {
    const snapshotId = operationId(rawId), client = await this.bulk.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await authorizeActor(client, actor);
      const state = (await client.query<{ period_month: string; version_number: number; status: DeliveryOperation['status'] }>(`SELECT s.period_month,s.version_number,o.status
        FROM ${operationTables} WHERE o.workspace_id=$1 AND s.id=$2`, [actor.workspaceId, snapshotId])).rows[0];
      if (!state) notFound();
      if (state.status !== 'PRONTA') throw new ApiError(409, 'DELIVERY_NOT_READY', 'Entrega ainda não está pronta');
      const column = kind === 'package' ? 'zip_bytes AS bytes, zip_hash AS hash' : 'manifest_bytes AS bytes, manifest_hash AS hash';
      const row = (await client.query<{ bytes: Buffer; hash: string }>(`SELECT ${column} FROM mimir.delivery_packages WHERE workspace_id=$1 AND snapshot_id=$2`, [actor.workspaceId, snapshotId])).rows[0];
      if (!row) throw new ApiError(500, 'INTERNAL_ERROR', 'Falha interna');
      await authorizeActor(client, actor); await client.query('COMMIT');
      return { bytes: row.bytes, sha256: row.hash, periodMonth: state.period_month, versionNumber: state.version_number };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; } throw error;
    } finally { client.release(broken); }
  }
  async close(): Promise<void> { await Promise.all([this.pool.end(), this.bulk.end()]); }
}
