import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { postgresTypes } from './postgres.js';
import { authorizeActor, lockWorkspace } from './postgres-workspace.js';
import { nextRevision } from '../domain/values.js';
import { ApiError } from '../http/error.js';
import { classifyImport, type ExistingOrigin } from '../imports/classify.js';
import { parseCsv } from '../imports/csv.js';
import { normalizeRow, type NormalizedRecord } from '../imports/rows.js';
import { initialPendingTypes, pendingDescriptions } from '../transactions/pending.js';
import type { ConfirmCommand, ImportCommand, ImportConfirmation, ImportPreview, ImportsPort } from '../ports/imports.js';
import type { WorkspaceActor } from '../ports/workspace.js';

type Queryable = pg.PoolClient;
const notFound = (): never => { throw new ApiError(404, 'NOT_FOUND', 'Objeto não encontrado'); };

async function accountType(client: Queryable, actor: WorkspaceActor, accountId: string, lock: boolean): Promise<'PF' | 'PJ'> {
  const account = (await client.query<{ account_type: 'PF' | 'PJ'; active: boolean }>(
    `SELECT account_type,active FROM mimir.accounts WHERE workspace_id=$1 AND id=$2${lock ? ' FOR SHARE' : ''}`, [actor.workspaceId, accountId])).rows[0] ?? notFound();
  if (!account.active) throw new ApiError(409, 'ACCOUNT_INACTIVE', 'Conta inativa');
  return account.account_type;
}

async function origins(client: Queryable, actor: WorkspaceActor, command: ImportCommand, records: readonly NormalizedRecord[]): Promise<Map<string, ExistingOrigin>> {
  const keys = [...new Set(records.flatMap(record => record.ok ? [record.row.externalId] : []))];
  const rows = (await client.query<{ external_id: string; original_fingerprint: string; status: 'ATIVA' | 'EXCLUIDA' }>(
    `SELECT o.external_id,o.original_fingerprint,t.status FROM mimir.import_origins o
     JOIN mimir.transactions t ON (t.workspace_id,t.id)=(o.workspace_id,o.transaction_id)
     WHERE o.workspace_id=$1 AND o.account_id=$2 AND o.source_code=$3 AND o.external_id=ANY($4::text[])`,
    [actor.workspaceId, command.accountId, command.sourceCode, keys])).rows;
  return new Map(rows.map(row => [row.external_id, { fingerprint: row.original_fingerprint, transactionStatus: row.status }]));
}

export class PostgresImports implements ImportsPort {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 2, types: postgresTypes, application_name: 'mimir-imports',
      connectionTimeoutMillis: 1500, query_timeout: 10000, idleTimeoutMillis: 10000, options: '-c statement_timeout=10000 -c search_path=mimir,pg_catalog' });
    this.pool.on('error', () => {});
  }

  async preview(actor: WorkspaceActor, command: ImportCommand): Promise<ImportPreview> {
    const records = parseCsv(command.file), client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await authorizeActor(client, actor);
      const revision = (await client.query<{ revision: number }>('SELECT revision FROM mimir.workspaces WHERE id=$1', [actor.workspaceId])).rows[0]!.revision;
      const type = await accountType(client, actor, command.accountId, false);
      const normalized = records.map(record => normalizeRow(record, command.periodMonth, type));
      const classified = classifyImport(normalized, await origins(client, actor, command, normalized));
      const known = Boolean((await client.query('SELECT 1 FROM mimir.import_origins WHERE workspace_id=$1 AND account_id=$2 AND source_code=$3 LIMIT 1',
        [actor.workspaceId, command.accountId, command.sourceCode])).rowCount);
      await authorizeActor(client, actor);
      await client.query('COMMIT');
      return { fileHash: command.fileHash, revision, accountId: command.accountId, sourceCode: command.sourceCode, periodMonth: command.periodMonth,
        sourceCodeKnown: known, totals: classified.totals, rows: classified.rows };
    } catch (error) { try { await client.query('ROLLBACK'); } catch { broken = true; } throw error; }
    finally { client.release(broken); }
  }

  async confirm(actor: WorkspaceActor, command: ConfirmCommand): Promise<{ created: boolean; result: ImportConfirmation }> {
    if (command.fileHash !== command.expectedFileHash) throw new ApiError(422, 'FILE_HASH_MISMATCH', 'Arquivo diferente do pré-visualizado; refaça a prévia');
    const records = parseCsv(command.file), client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const current = await lockWorkspace(client, actor);
      const type = await accountType(client, actor, command.accountId, true);
      const normalized = records.map(record => normalizeRow(record, command.periodMonth, type));
      const { totals, newRows } = classifyImport(normalized, await origins(client, actor, command, normalized));
      if (totals.invalid) throw new ApiError(422, 'IMPORT_INVALID_ROWS', `${totals.invalid} linha(s) inválida(s); corrija o arquivo e refaça a prévia`);
      if (totals.conflicting) throw new ApiError(409, 'IMPORT_CONFLICT', `${totals.conflicting} linha(s) em conflito; nenhuma linha foi importada`);
      const base = { fileHash: command.fileHash, totals };
      if (!newRows.length) {
        await authorizeActor(client, actor);
        await client.query('COMMIT');
        return { created: false, result: { ...base, batchId: null, transactionIds: [], revision: current } };
      }
      const revision = nextRevision(current, command.expectedRevision), transactionIds: string[] = [];
      await client.query('INSERT INTO mimir.periods(id,workspace_id,period_month) VALUES($1,$2,$3) ON CONFLICT(workspace_id,period_month) DO NOTHING',
        [randomUUID(), actor.workspaceId, command.periodMonth]);
      for (const { row, fingerprint } of newRows) {
        const id = randomUUID();
        await client.query(`INSERT INTO mimir.transactions
          (id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,description,category,classification,is_pf_business_expense,explanation,source_type,source_code,external_id)
          VALUES($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,'CSV',$13,$14)`,
          [id, actor.workspaceId, command.accountId, row.occurredOn, command.periodMonth, row.direction, row.amountCents, row.description, row.category,
            row.classification, row.isPfBusinessExpense, row.explanation, command.sourceCode, row.externalId]);
        await client.query(`INSERT INTO mimir.import_origins(id,workspace_id,account_id,source_code,external_id,transaction_id,original_fingerprint,normalized_original_row)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), actor.workspaceId, command.accountId, command.sourceCode, row.externalId, id, fingerprint, JSON.stringify(row)]);
        for (const pending of initialPendingTypes(row)) await client.query(
          'INSERT INTO mimir.pending_items(id,workspace_id,transaction_id,type,description) VALUES($1,$2,$3,$4,$5)',
          [randomUUID(), actor.workspaceId, id, pending, pendingDescriptions[pending]]);
        transactionIds.push(id);
      }
      const batchId = randomUUID();
      await client.query(`INSERT INTO mimir.import_batches(id,workspace_id,account_id,period_month,source_code,file_hash,row_count,inserted_count,ignored_count,repeated_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [batchId, actor.workspaceId, command.accountId, command.periodMonth, command.sourceCode, command.fileHash,
        totals.rows, totals.new, totals.ignored, totals.repeated]);
      await authorizeActor(client, actor);
      await client.query('UPDATE mimir.workspaces SET revision=$1 WHERE id=$2', [revision, actor.workspaceId]);
      await client.query('COMMIT');
      return { created: true, result: { ...base, batchId, transactionIds, revision } };
    } catch (error) { try { await client.query('ROLLBACK'); } catch { broken = true; } throw error; }
    finally { client.release(broken); }
  }

  async close(): Promise<void> { await this.pool.end(); }
}
