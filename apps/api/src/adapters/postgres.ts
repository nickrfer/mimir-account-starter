import pg from 'pg';
import type { PersistencePort } from '../ports/persistence.js';
import { civilDate } from '../domain/values.js';
export { civilDate };

export function safeInteger(value: string): number {
  if (!/^-?\d+$/.test(value)) throw new Error('BIGINT inválido');
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('BIGINT fora da faixa segura');
  return result;
}

export const postgresTypes = {
  getTypeParser(oid: number, format?: string) {
    if (format !== 'binary' && oid === 20) return safeInteger;
    if (format !== 'binary' && oid === 1082) return civilDate;
    return pg.types.getTypeParser(oid, format as 'text' | undefined);
  }
};

export class PostgresPersistence implements PersistencePort {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4,
      connectionTimeoutMillis: 1500, idleTimeoutMillis: 10000, query_timeout: 1500,
      options: '-c statement_timeout=1500 -c search_path=mimir,pg_catalog', types: postgresTypes });
    this.pool.on('error', () => { /* readiness reports failure; never log driver errors */ });
  }
  async ready(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: boolean }>(
        `SELECT current_user = $1 AND EXISTS
         (SELECT 1 FROM mimir.schema_migrations WHERE version = $2) AS ready`,
        ['mimir_runtime', '009_pending_description.sql']);
      return result.rows[0]?.ready === true;
    } catch { return false; }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
