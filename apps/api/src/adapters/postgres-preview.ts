import pg from 'pg';
import { postgresTypes } from './postgres.js';
import { authorizeActor } from './postgres-workspace.js';
import { previewMonth } from '../preview/http.js';
import { selectPeriod } from './postgres-period-selection.js';
import type { WorkspaceActor } from '../ports/workspace.js';
import type { Preview, PreviewPort } from '../ports/preview.js';

export class PostgresPreview implements PreviewPort {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4, types: postgresTypes, application_name: 'mimir-preview',
      connectionTimeoutMillis: 1500, query_timeout: 1500, idleTimeoutMillis: 10000, options: '-c statement_timeout=1500 -c search_path=mimir,pg_catalog' });
    this.pool.on('error', () => {});
  }
  async readPeriodPreview(actor: WorkspaceActor, month: string): Promise<Preview> {
    previewMonth(month);
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await authorizeActor(client, actor);
      const { preview: result } = await selectPeriod(client, actor, month);
      await authorizeActor(client, actor);
      await client.query('COMMIT'); return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
