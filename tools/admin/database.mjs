import pg from 'pg';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

export async function provision(env = process.env) {
  const client = new pg.Client({ connectionString: env.PROVISION_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(81001)');
    for (const [name, password] of [['mimir_migrator', env.MIGRATOR_PASSWORD], ['mimir_runtime', env.APP_ROLE_PASSWORD]]) {
      if (!/^[a-f0-9]{64}$/.test(password ?? '')) throw new Error('Segredo inválido');
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name]);
      // Identifiers are constants; passwords are validated generated hex, never logged.
      if (!exists.rowCount) await client.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    }
    await client.query('REVOKE ALL ON DATABASE mimir FROM PUBLIC');
    await client.query('GRANT CONNECT ON DATABASE mimir TO mimir_migrator, mimir_runtime');
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await client.query('CREATE SCHEMA IF NOT EXISTS mimir AUTHORIZATION mimir_migrator');
    await client.query('REVOKE ALL ON SCHEMA mimir FROM PUBLIC');
    await client.query('GRANT USAGE ON SCHEMA mimir TO mimir_runtime');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.end(); }
}

export async function migrate(url = process.env.MIGRATION_DATABASE_URL, directory = new URL('../../database/migrations/', import.meta.url)) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(81002)');
    await client.query(`CREATE TABLE IF NOT EXISTS mimir.schema_migrations
      (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    await client.query('GRANT SELECT ON mimir.schema_migrations TO mimir_runtime');
    for (const version of (await readdir(directory)).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort()) {
      const sql = await readFile(new URL(version, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT checksum FROM mimir.schema_migrations WHERE version=$1', [version]);
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) throw new Error('Migração aplicada foi alterada');
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO mimir.schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
      applied.push(version);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.end(); }
}
