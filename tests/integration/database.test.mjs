import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { migrate } from '../../tools/admin/database.mjs';
import { postgresTypes } from '../../apps/api/dist/adapters/postgres.js';

test('PostgreSQL real: I01', async t => {
  const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const runtimeUrl = new URL(process.env.MIGRATION_DATABASE_URL);
  runtimeUrl.username = 'mimir_runtime'; runtimeUrl.password = process.env.APP_ROLE_PASSWORD;
  const runtime = new pg.Client({ connectionString: runtimeUrl.toString(), types: postgresTypes });
  await admin.connect(); await runtime.connect();
  t.after(async () => { await runtime.end(); await admin.end(); });
  const w1 = randomUUID(), w2 = randomUUID(), u1 = randomUUID(), u2 = randomUUID();
  const a1 = randomUUID(), a2 = randomUUID(), tx = randomUUID(), d1 = randomUUID(), d2 = randomUUID();
  const bytes = Buffer.from('%PDF-1.4\nSYNTHETIC I01\n');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const document = (id, workspace, supersedes = null) => runtime.query(
    `INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes,supersedes_document_id)
     VALUES($1,$2,'synthetic.pdf','application/pdf',$3,$4,$5,$6)`, [id, workspace, bytes.length, hash, bytes, supersedes]);
  const denied = (sql, code = '42501', values = []) => assert.rejects(runtime.query(sql, values), error => error.code === code);
  await admin.query('BEGIN');
  for (const [user, workspace, account] of [[u1,w1,a1],[u2,w2,a2]]) {
    await admin.query(`INSERT INTO mimir.users(id,email,display_name,password_hash) VALUES($1,$2,'Synthetic','$argon2id$synthetic-disabled')`, [user, `${user}@example.invalid`]);
    await admin.query(`INSERT INTO mimir.workspaces(id,owner_id,company_name) VALUES($1,$2,'Synthetic')`, [workspace,user]);
    await admin.query(`INSERT INTO mimir.accounts(id,workspace_id,name,name_key,account_type) VALUES($1,$2,'Synthetic','synthetic','PF')`, [account,workspace]);
    await admin.query(`INSERT INTO mimir.periods(id,workspace_id,period_month) VALUES($1,$2,'2024-02')`, [randomUUID(),workspace]);
  }
  await admin.query('COMMIT');
  const insertTx = (id, workspace, account, amount = '99999999999') => runtime.query(
    `INSERT INTO mimir.transactions(id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,
     description,category,classification,source_type,source_code,external_id)
     VALUES($1::uuid,$2,$3,'2024-02-29','2024-02','SAIDA',$4,'Synthetic','Test','DESPESA','MANUAL','MANUAL',$1::uuid::text)`,
    [id,workspace,account,amount]);

  await t.test('migrations: second execution applies nothing', async () => assert.deepEqual(await migrate(), []));
  await t.test('migration checksum drift is rejected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mimir-drift-'));
    await writeFile(join(dir, '001_core.sql'), '-- altered');
    await assert.rejects(migrate(undefined, pathToFileURL(dir + '/')), /alterada/);
  });
  await t.test('failed migration rolls DDL back atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mimir-rollback-'));
    await writeFile(join(dir, '002_failure.sql'), 'CREATE TABLE mimir.rollback_probe(id int); SELECT nonexistent_column;');
    await assert.rejects(migrate(undefined, pathToFileURL(dir + '/')), error => error.code === '42703');
    assert.equal((await admin.query("SELECT to_regclass('mimir.rollback_probe') IS NULL AS absent")).rows[0].absent, true);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM mimir.schema_migrations")).rows[0].n, 8);
  });
  await t.test('runtime is not privileged, owner, or migrator member', async () => {
    const role = (await runtime.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
      pg_has_role(current_user,'mimir_migrator','MEMBER') AS member FROM pg_roles WHERE rolname=current_user`)).rows[0];
    assert.ok(Object.values(role).every(value => value === false));
    assert.equal((await runtime.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='mimir' AND tableowner=current_user`)).rows[0].n, 0);
    await denied('SET ROLE mimir_migrator');
    await denied('CREATE TABLE mimir.forbidden(id int)');
    await denied('CREATE TABLE public.forbidden(id int)');
    await denied('CREATE SCHEMA forbidden');
    await denied('CREATE TEMP TABLE forbidden(id int)');
    await denied('ALTER TABLE mimir.documents ADD COLUMN forbidden text');
    await denied('DROP TABLE mimir.documents');
    await denied('GRANT mimir_migrator TO mimir_runtime');
    await denied('INSERT INTO mimir.users DEFAULT VALUES');
    await denied('INSERT INTO mimir.workspaces DEFAULT VALUES');
    await denied("UPDATE mimir.users SET active=false");
    await denied("UPDATE mimir.schema_migrations SET checksum='forbidden'");
  });
  await t.test('documents INSERT/SELECT allowed; UPDATE/DELETE/TRUNCATE denied', async () => {
    await document(d1,w1); await document(d2,w2);
    const row = (await runtime.query('SELECT bytes FROM mimir.documents WHERE id=$1',[d1])).rows[0];
    assert.deepEqual(row.bytes, bytes);
    await denied("UPDATE mimir.documents SET original_name='forbidden'");
    await denied('DELETE FROM mimir.documents');
    await denied('TRUNCATE mimir.documents CASCADE');
    await denied('TRUNCATE mimir.accounts CASCADE');
  });
  await t.test('composite FKs reject account, document, replacement and session across workspaces', async () => {
    await insertTx(tx,w1,a1);
    await assert.rejects(insertTx(randomUUID(),w1,a2), error => error.code === '23503');
    await denied('INSERT INTO mimir.transaction_documents VALUES($1,$2,$3)', '23503', [w1,tx,d2]);
    await denied('INSERT INTO mimir.transaction_documents VALUES($1,$2,$3)', '23503', [w2,tx,d2]);
    await assert.rejects(document(randomUUID(),w1,d2), error => error.code === '23503');
    await denied(`INSERT INTO mimir.sessions(id,user_id,workspace_id,token_hash,csrf_token,expires_at)
      VALUES($1,$2,$3,$4,'synthetic',clock_timestamp()+interval '1 hour')`, '23503', [randomUUID(),u1,w2,'a'.repeat(64)]);
    await runtime.query('INSERT INTO mimir.transaction_documents VALUES($1,$2,$3)', [w1,tx,d1]);
    await assert.rejects(admin.query('DELETE FROM mimir.documents WHERE id=$1',[d1]), error => error.code === '23001');
    await assert.rejects(admin.query('DELETE FROM mimir.workspaces WHERE id=$1',[w1]), error => error.code === '23001');
  });
  await t.test('real BIGINT/DATE mapping preserves value and civil date', async () => {
    const row = (await runtime.query('SELECT amount_cents,occurred_on FROM mimir.transactions WHERE id=$1',[tx])).rows[0];
    assert.equal(row.amount_cents,99999999999); assert.equal(row.occurred_on,'2024-02-29');
    await assert.rejects(runtime.query('SELECT 9007199254740992::bigint'), /faixa segura/);
    await assert.rejects(insertTx(randomUUID(),w1,a1,'100000000000'), error => error.code === '23514');
  });
  await t.test('failed document link rolls document and revision back together', async () => {
    const id = randomUUID();
    await runtime.query('BEGIN');
    await runtime.query('SELECT id FROM mimir.workspaces WHERE id=$1 FOR UPDATE',[w1]);
    await runtime.query('UPDATE mimir.workspaces SET revision=revision+1 WHERE id=$1',[w1]);
    await document(id,w1);
    await denied('INSERT INTO mimir.transaction_documents VALUES($1,$2,$3)', '23503', [w1,randomUUID(),id]);
    await runtime.query('ROLLBACK');
    assert.equal((await runtime.query('SELECT revision FROM mimir.workspaces WHERE id=$1',[w1])).rows[0].revision,1);
    assert.equal((await runtime.query('SELECT 1 FROM mimir.documents WHERE id=$1',[id])).rowCount,0);
  });
  await t.test('persistent marker exists for service recreation check', async () => {
    assert.equal((await runtime.query('SELECT count(*)::int AS n FROM mimir.documents WHERE workspace_id=ANY($1::uuid[])',[[w1,w2]])).rows[0].n,2);
  });
});
