import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { postgresTypes } from './postgres.js';
import { authorizeActor, lockWorkspace } from './postgres-workspace.js';
import { nextRevision } from '../domain/values.js';
import { ApiError } from '../http/error.js';
import { decidePendingAction } from '../pending/lifecycle.js';
import type { WorkspaceActor } from '../ports/workspace.js';
import type { PendingCommand, PendingItem, PendingItemMutation, PendingItemsPort, PendingPage, PendingStatus, PendingType } from '../ports/pending-items.js';

interface PendingRow { id: string; transaction_id: string; type: PendingType; status: PendingStatus; description: string; justification: string; transaction_status?: 'ATIVA' | 'EXCLUIDA' }
const columns = 'p.id,p.transaction_id,p.type,p.status,p.description,p.justification';
const item = (row: PendingRow): PendingItem => ({ pendingId: row.id, transactionId: row.transaction_id, pendingType: row.type, status: row.status,
  description: row.description, justification: row.justification });
const notFound = (): never => { throw new ApiError(404, 'NOT_FOUND', 'Objeto não encontrado'); };
const inactive = () => new ApiError(409, 'TRANSACTION_INACTIVE', 'Movimentação excluída');

export class PostgresPendingItems implements PendingItemsPort {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4, types: postgresTypes, application_name: 'mimir-pending-items',
      connectionTimeoutMillis: 1500, query_timeout: 1500, idleTimeoutMillis: 10000, options: '-c statement_timeout=1500 -c search_path=mimir,pg_catalog' });
    this.pool.on('error', () => {});
  }
  private async write<T>(actor: WorkspaceActor, work: (client: pg.PoolClient, current: number) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(client, await lockWorkspace(client, actor));
      await authorizeActor(client, actor);
      await client.query('COMMIT'); return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }
  private async read<T>(actor: WorkspaceActor, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await authorizeActor(client, actor);
      const result = await work(client);
      await authorizeActor(client, actor);
      await client.query('COMMIT'); return result;
    } catch (error) { try { await client.query('ROLLBACK'); } catch { broken = true; } throw error; }
    finally { client.release(broken); }
  }

  list(actor: WorkspaceActor, month: string, page: PendingPage) {
    return this.read(actor, async client => {
      const revision = (await client.query<{ revision: number }>('SELECT revision FROM mimir.workspaces WHERE id=$1', [actor.workspaceId])).rows[0]!.revision;
      const rows = (await client.query<PendingRow>(`SELECT ${columns} FROM mimir.pending_items p
        JOIN mimir.transactions t ON (t.workspace_id,t.id)=(p.workspace_id,p.transaction_id)
        WHERE p.workspace_id=$1 AND t.period_month=$2 AND t.status='ATIVA'
        AND ($3::text IS NULL OR (p.type COLLATE "C",p.id)>($3::text COLLATE "C",$4::uuid))
        ORDER BY p.type COLLATE "C",p.id LIMIT $5`,
        [actor.workspaceId, month, page.cursor?.type ?? null, page.cursor?.id ?? null, page.limit + 1])).rows;
      const items = rows.slice(0, page.limit).map(item), last = items.at(-1);
      return { items, nextCursor: rows.length > page.limit && last ? `${last.pendingType}_${last.pendingId}` : null, revision };
    });
  }

  registerQuestion(actor: WorkspaceActor, transactionId: string, description: string, expectedRevision: number): Promise<PendingItemMutation> {
    return this.write(actor, async (client, current) => {
      const transaction = (await client.query<{ status: 'ATIVA' | 'EXCLUIDA' }>(
        'SELECT status FROM mimir.transactions WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE', [actor.workspaceId, transactionId])).rows[0] ?? notFound();
      const revision = nextRevision(current, expectedRevision);
      if (transaction.status !== 'ATIVA') throw inactive();
      const existing = await client.query(`SELECT 1 FROM mimir.pending_items WHERE workspace_id=$1 AND transaction_id=$2 AND type='DUVIDA_CADASTRADA'`,
        [actor.workspaceId, transactionId]);
      if (existing.rowCount) throw new ApiError(409, 'QUESTION_ALREADY_EXISTS', 'Movimentação já tem dúvida registrada');
      const id = randomUUID();
      await client.query(`INSERT INTO mimir.pending_items(id,workspace_id,transaction_id,type,description) VALUES($1,$2,$3,'DUVIDA_CADASTRADA',$4)`,
        [id, actor.workspaceId, transactionId, description]);
      await client.query('UPDATE mimir.workspaces SET revision=$1 WHERE id=$2', [revision, actor.workspaceId]);
      return { pendingItem: { pendingId: id, transactionId, pendingType: 'DUVIDA_CADASTRADA', status: 'PENDENTE', description, justification: '' }, revision };
    });
  }

  conduct(actor: WorkspaceActor, pendingId: string, command: PendingCommand, expectedRevision: number): Promise<PendingItemMutation> {
    return this.write(actor, async (client, current) => {
      const row = (await client.query<PendingRow>(`SELECT ${columns},t.status AS transaction_status FROM mimir.pending_items p
        JOIN mimir.transactions t ON (t.workspace_id,t.id)=(p.workspace_id,p.transaction_id)
        WHERE p.workspace_id=$1 AND p.id=$2 FOR NO KEY UPDATE OF p`, [actor.workspaceId, pendingId])).rows[0] ?? notFound();
      const revision = nextRevision(current, expectedRevision);
      if (row.transaction_status !== 'ATIVA') throw inactive();
      const decision = decidePendingAction({ type: row.type, status: row.status, description: row.description, justification: row.justification }, command);
      if (decision.kind === 'CONFLICT') throw new ApiError(409, decision.code,
        decision.code === 'PENDING_RESOLVED' ? 'Pendência resolvida; reabra antes' : 'Pendência automática só se resolve eliminando a causa');
      if (decision.kind === 'NOOP') return { pendingItem: item(row), revision: current };
      await client.query(`UPDATE mimir.pending_items SET status=$3,justification=$4,description=$5,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
        [actor.workspaceId, pendingId, decision.status, decision.justification, decision.description]);
      await client.query('UPDATE mimir.workspaces SET revision=$1 WHERE id=$2', [revision, actor.workspaceId]);
      return { pendingItem: item({ ...row, status: decision.status, justification: decision.justification, description: decision.description }), revision };
    });
  }

  async close(): Promise<void> { await this.pool.end(); }
}
