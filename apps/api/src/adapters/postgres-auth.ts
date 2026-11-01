import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { postgresTypes } from './postgres.js';
import type { AuthenticationPort, LoginIdentity, SessionContext } from '../ports/authentication.js';

interface ContextRow { user_id: string; display_name: string; workspace_id: string; company_name: string; revision: number; csrf_token: string }
const context = (row: ContextRow): SessionContext => ({ userId: row.user_id, displayName: row.display_name,
  workspace: { workspaceId: row.workspace_id, companyName: row.company_name, currency: 'BRL' }, revision: row.revision, csrfToken: row.csrf_token });

export class PostgresAuthentication implements AuthenticationPort {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4, types: postgresTypes,
      connectionTimeoutMillis: 1500, query_timeout: 1500, idleTimeoutMillis: 10000,
      options: '-c statement_timeout=1500 -c search_path=mimir,pg_catalog' });
    this.pool.on('error', () => {});
  }
  async findIdentity(email: string): Promise<LoginIdentity | null> {
    const result = await this.pool.query<{ id: string; password_hash: string; active: boolean }>(
      'SELECT id,password_hash,active FROM mimir.users WHERE email=$1', [email]);
    const row = result.rows[0];
    return row ? { userId: row.id, passwordHash: row.password_hash, active: row.active } : null;
  }
  async createSession(userId: string, previousHash: string | null, tokenHash: string, csrfToken: string): Promise<SessionContext | null> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await client.query<ContextRow>(`SELECT u.id AS user_id,u.display_name,w.id AS workspace_id,w.company_name,w.revision
        FROM mimir.users u JOIN mimir.workspaces w ON w.owner_id=u.id WHERE u.id=$1 AND u.active FOR UPDATE OF w`, [userId]);
      const row = result.rows[0];
      if (!row) { await client.query('ROLLBACK'); return null; }
      if (previousHash) await client.query(`UPDATE mimir.sessions SET revoked_at=clock_timestamp()
        WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [previousHash]);
      await client.query(`WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
        INSERT INTO mimir.sessions(id,user_id,workspace_id,token_hash,csrf_token,created_at,expires_at)
        SELECT $1,$2,$3,$4,$5,at,at+interval '8 hours' FROM instant`, [randomUUID(),userId,row.workspace_id,tokenHash,csrfToken]);
      await client.query('COMMIT');
      return context({ ...row, csrf_token: csrfToken });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }
  async session(tokenHash: string): Promise<SessionContext | null> {
    const result = await this.pool.query<ContextRow>(`SELECT u.id AS user_id,u.display_name,w.id AS workspace_id,w.company_name,w.revision,s.csrf_token
      FROM mimir.sessions s JOIN mimir.users u ON u.id=s.user_id JOIN mimir.workspaces w ON (w.id,w.owner_id)=(s.workspace_id,s.user_id)
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.active`, [tokenHash]);
    return result.rows[0] ? context(result.rows[0]) : null;
  }
  async revoke(tokenHash: string): Promise<void> {
    await this.pool.query('UPDATE mimir.sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1 AND revoked_at IS NULL', [tokenHash]);
  }
  async close(): Promise<void> { await this.pool.end(); }
}
