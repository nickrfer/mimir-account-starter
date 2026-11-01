import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { postgresTypes } from './postgres.js';
import { ApiError } from '../http/error.js';
import { nextRevision } from '../domain/values.js';
import { authorizeActor, lockWorkspace } from './postgres-workspace.js';
import type { Account, AccountActor, AccountPage, AccountsPort, CreateAccount } from '../ports/accounts.js';

interface AccountRow { id: string; name: string; account_type: 'PF' | 'PJ'; active: boolean }
const account = (row: AccountRow): Account => ({ id: row.id, name: row.name, accountType: row.account_type, active: row.active });

export class PostgresAccounts implements AccountsPort {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4, types: postgresTypes, application_name: 'mimir-accounts',
      connectionTimeoutMillis: 1500, query_timeout: 1500, idleTimeoutMillis: 10000,
      options: '-c statement_timeout=1500 -c search_path=mimir,pg_catalog' });
    this.pool.on('error', () => {});
  }
  async create(actor: AccountActor, command: CreateAccount): Promise<{ account: Account; revision: number }> {
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const revision = nextRevision(await lockWorkspace(client,actor), command.expectedRevision);
      const inserted = await client.query<AccountRow>(`INSERT INTO mimir.accounts(id,workspace_id,name,name_key,account_type)
        VALUES($1,$2,$3,$4,$5) RETURNING id,name,account_type,active`,
        [randomUUID(),actor.workspaceId,command.name,command.nameKey,command.accountType]);
      await client.query('UPDATE mimir.workspaces SET revision=$1 WHERE id=$2', [revision,actor.workspaceId]);
      await client.query('COMMIT');
      return { account: account(inserted.rows[0]!), revision };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      if (error instanceof pg.DatabaseError && error.code === '23505' && error.constraint === 'accounts_workspace_id_name_key_key') {
        throw new ApiError(409, 'ACCOUNT_NAME_CONFLICT', 'Nome de conta já utilizado');
      }
      throw error;
    } finally { client.release(broken); }
  }
  async list(actor: AccountActor, page: AccountPage): Promise<{ items: Account[]; nextCursor: string | null }> {
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await authorizeActor(client, actor);
      if (page.cursor) {
        const anchor = await client.query('SELECT 1 FROM mimir.accounts WHERE workspace_id=$1 AND id=$2', [actor.workspaceId,page.cursor]);
        if (!anchor.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Objeto não encontrado');
      }
      const result = await client.query<AccountRow>(`SELECT id,name,account_type,active FROM mimir.accounts
        WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`, [actor.workspaceId,page.cursor,page.limit+1]);
      const items = result.rows.slice(0,page.limit).map(account);
      const nextCursor = result.rows.length>page.limit ? items.at(-1)!.id : null;
      await client.query('COMMIT');
      return { items, nextCursor };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
