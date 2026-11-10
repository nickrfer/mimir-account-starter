import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import pg from 'pg';
import { PostgresAuthentication } from '../../../apps/api/dist/adapters/postgres-auth.js';
import { PostgresPersistence } from '../../../apps/api/dist/adapters/postgres.js';
import { PostgresAccounts } from '../../../apps/api/dist/adapters/postgres-accounts.js';
import { PostgresTransactions } from '../../../apps/api/dist/adapters/postgres-transactions.js';
import { PostgresDocuments } from '../../../apps/api/dist/adapters/postgres-documents.js';
import { PostgresPreview } from '../../../apps/api/dist/adapters/postgres-preview.js';
import { PostgresDeliveries } from '../../../apps/api/dist/adapters/postgres-deliveries.js';
import { AuthenticationService } from '../../../apps/api/dist/auth/service.js';
import { createApp } from '../../../apps/api/dist/server.js';
import { client, environment, identity, runtimeUrl, sleep, writeResult } from '../lib/harness.mjs';

const SIGNALS = '/signals', MONTH = '2026-10', POINTS = ['P1', 'P2', 'P3', 'P4', 'P5'], PER_POINT = 6, WINDOW_S = 120;
const run = promisify(execFile);
const invalidRuns = JSON.parse(await readFile('tools/avaliacao/execucoes-invalidas.json', 'utf8')).C02 ?? [];

function readZip(bytes) {
  const end = bytes.length - 22, count = bytes.readUInt16LE(end + 10), entries = new Map(); let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = bytes.readUInt16LE(at + 10), csize = bytes.readUInt32LE(at + 20), nameLength = bytes.readUInt16LE(at + 28), offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8'), start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    entries.set(name, method === 8 ? inflateRawSync(bytes.subarray(start, start + csize)) : bytes.subarray(start, start + csize));
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return entries;
}

async function query(sql, params = []) {
  for (let i = 0; ; i++) {
    const c = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL, connectionTimeoutMillis: 2000 });
    try { await c.connect(); const r = await c.query(sql, params); return r; }
    catch (error) { if (i >= 60) throw error; await sleep(1000); }
    finally { await c.end().catch(() => undefined); }
  }
}

const url = runtimeUrl();
const auth = new PostgresAuthentication(url), persistence = new PostgresPersistence(url), accounts = new PostgresAccounts(url), transactions = new PostgresTransactions(url);
const documents = new PostgresDocuments(url), preview = new PostgresPreview(url), deliveries = new PostgresDeliveries(url);
const service = await AuthenticationService.create(auth), origin = 'http://127.0.0.1:3100';
const server = createApp(persistence, '/app/apps/web/dist', { service, origins: new Set([origin]), allowLocalHttp: true, log: () => {} }, accounts, transactions, documents, preview, deliveries);
server.listen(3100, '127.0.0.1'); await once(server, 'listening');
const api = { base: origin, origin };
const admin = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL }); await admin.connect();
const env = await environment(admin); await admin.end();
const work = await mkdtemp(join(tmpdir(), 'mimir-c02-'));
const workspaces = [];

async function one(index, point) {
  const A = await identity(api, `Synthetic C02 ${index}`), a = client(api, await A.login());
  workspaces.push(A.workspaceId); await writeFile(`${SIGNALS}/workspaces.json`, JSON.stringify(workspaces));
  const rev = async () => Number((await query('SELECT revision::text n FROM mimir.workspaces WHERE id=$1', [A.workspaceId])).rows[0].n);
  const ok = (r, code) => { if (r.status !== code) throw new Error(`setup ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  const pj = ok(await a.request('POST', '/accounts', { name: 'Conta PJ', accountType: 'PJ', expectedRevision: await rev() }), 201).account.id;
  for (let i = 0; i < 3; i++) {
    const id = ok(await a.request('POST', '/transactions', { accountId: pj, occurredOn: `${MONTH}-1${i}`, direction: 'SAIDA', amountCents: 1000 + i, description: `Synthetic C02 ${i}`, category: 'GERAL',
      classification: 'DESPESA', isPfBusinessExpense: false, explanation: '', expectedRevision: await rev() }), 201).transaction.transactionId;
    const f = new FormData(); f.append('file', new Blob([Buffer.from(`%PDF-1.7\nSynthetic C02 ${index}-${i}\n${'x'.repeat(2000)}\n%%EOF\n`)], { type: 'application/pdf' }), `d${i}.pdf`);
    f.append('expectedRevision', String(await rev())); ok(await a.request('POST', `/transactions/${id}/documents`, f), 201);
  }
  await writeFile(`${SIGNALS}/run.json`, JSON.stringify({ index, point, workspaceId: A.workspaceId }));
  await writeFile(`${SIGNALS}/armed-${index}`, point);
  const op = ok(await a.request('POST', '/deliveries', { periodMonth: MONTH, expectedRevision: await rev(), rectificationReason: '' }, { 'Idempotency-Key': `c02-${index}-${Date.now()}` }), 202);
  await writeFile(`${SIGNALS}/captured-${index}`, op.id);
  for (let i = 0; i < 1200 && !existsSync(`${SIGNALS}/restored-${index}`); i++) await sleep(100);
  if (!existsSync(`${SIGNALS}/restored-${index}`)) return { index, point, invalid: true, reason: 'falha não injetada em 120 s (ponto não alcançado)' };
  const restoredAt = (await query('SELECT clock_timestamp() t')).rows[0].t;
  let status = null;
  for (let i = 0; i < 240; i++) {
    status = (await query('SELECT status FROM mimir.delivery_operations WHERE id=$1', [op.id])).rows[0]?.status;
    if (status === 'PRONTA' || status === 'FALHA') break;
    await sleep(1000);
  }
  const facts = (await query(`SELECT o.attempt_count, o.fencing_token::text token, p.created_at published_at,
    (SELECT count(*)::int FROM mimir.delivery_packages x WHERE x.snapshot_id=o.snapshot_id) packages,
    (SELECT count(*)::int FROM mimir.delivery_operations y WHERE y.workspace_id=o.workspace_id) versions
    FROM mimir.delivery_operations o LEFT JOIN mimir.delivery_packages p ON p.snapshot_id=o.snapshot_id WHERE o.id=$1`, [op.id])).rows[0];
  let verified = false;
  if (status === 'PRONTA') {
    const zip = (await a.request('GET', `/deliveries/${op.snapshotId}/package`)).raw, manifest = (await a.request('GET', `/deliveries/${op.snapshotId}/manifest`)).raw;
    const dir = join(work, `run${index}`);
    for (const [name, data] of readZip(zip)) { await mkdir(dirname(join(dir, name)), { recursive: true }); await writeFile(join(dir, name), data); }
    await writeFile(`${dir}.ref.json`, manifest);
    try { await run(process.execPath, ['packages/verifier/dist/index.js', dir, `${dir}.ref.json`]); verified = true; } catch { verified = false; }
  }
  const seconds = facts.published_at ? (new Date(facts.published_at) - new Date(restoredAt)) / 1000 : null;
  const pass = status === 'PRONTA' && facts.packages === 1 && facts.versions === 1 && verified && seconds !== null && seconds <= WINDOW_S && facts.attempt_count <= 3;
  await writeFile(`${SIGNALS}/done-${index}`, status ?? 'null');
  return { index, point, status, attempts: facts.attempt_count, fencingToken: Number(facts.token), packages: facts.packages, versions: facts.versions, verified,
    secondsAfterRestore: seconds === null ? null : Math.round(seconds * 10) / 10, pass };
}

try {
  const runs = [];
  let index = 0;
  for (const point of POINTS) for (let i = 0; i < PER_POINT; i++) {
    index++;
    let outcome = await one(index, point);
    while (outcome.invalid) { invalidRuns.push({ index, point, reason: outcome.reason }); console.log(`EVAL execução ${index} inválida: ${outcome.reason}; substituindo`); await writeFile(`${SIGNALS}/done-${index}`, 'invalid'); index++; outcome = await one(index, point); }
    runs.push(outcome);
    console.log(`${outcome.pass ? 'EVAL' : 'CASE-FAIL'} ${index}/30 ${point} ${outcome.status} tentativas=${outcome.attempts} ${outcome.secondsAfterRestore}s após restauração`);
  }
  await writeFile(`${SIGNALS}/finished`, 'ok');
  const verdict = runs.length === 30 && runs.every(r => r.pass);
  const byPoint = Object.fromEntries(POINTS.map(p => { const rs = runs.filter(r => r.point === p), t = rs.map(r => r.secondsAfterRestore).filter(x => x !== null);
    return [p, { runs: rs.length, recovered: rs.filter(r => r.pass).length, maxSeconds: t.length ? Math.max(...t) : null, maxAttempts: Math.max(...rs.map(r => r.attempts)) }]; }));
  const result = { ...env, finishedAt: new Date().toISOString(), criterion: '30 execuções com uma falha transitória (6 por 5 pontos): concluir em PRONTA, sem versão duplicada nem pacote parcial, em até 120 s após restabelecer API e banco; FALHA terminal não conta (RNF-02).',
    summary: { runs: runs.length, recovered: runs.filter(r => r.pass).length, terminalFailures: runs.filter(r => r.status === 'FALHA').length, maxSecondsAfterRestore: Math.max(...runs.map(r => r.secondsAfterRestore ?? Infinity)), byPoint, substitutions: invalidRuns.length },
    substitutions: invalidRuns, verdict: verdict ? 'ATENDE' : 'NAO_ATENDE', runs };
  const label = { P1: 'Aquisição (banco parado)', P2: 'Leitura do snapshot (banco parado)', P3: 'Leitura de anexos (banco parado)', P4: 'Publicação (banco parado)', P5: 'Processo do executor encerrado (SIGKILL)' };
  await writeResult(result, `# Resultado C02 - Recuperação (RNF-02)

Veredito: **${verdict ? 'atende' : 'não atende'}** ao critério: ${result.criterion}

- Commit \`${env.commit}\` (tag \`poc-v1.0.0\`; produto igual à tag: ${env.productEqualToTag ? 'sim' : 'não'}); projeto \`${env.project}\`; Docker ${env.docker}; PostgreSQL ${env.postgres}; Node ${env.node}.
- Executor de produção (\`DeliveryExecutor\` + \`PostgresExecutor\`, polling 2 s, lease 30 s, renovação 5 s, até 3 tentativas) em contêiner próprio, restrito aos espaços do teste; a API do cenário roda sem executor embutido. Desvio declarado no protocolo.
- P1–P4: o decorador do harness pausa na operação, o orquestrador para o banco (\`docker stop\`), libera a operação (que encontra o banco indisponível), espera alguns segundos e reinicia o banco (\`up --wait\`). P5: o processo do executor é encerrado com SIGKILL durante a montagem e outro é iniciado.
- Tempo medido no relógio do banco: do instante em que o banco/executor está de volta até \`delivery_packages.created_at\`.
- Recuperadas: ${result.summary.recovered}/${result.summary.runs}; FALHA terminal: ${result.summary.terminalFailures}; maior tempo após restauração: ${result.summary.maxSecondsAfterRestore} s. Substituições: ${result.summary.substitutions}.

| Ponto | Falha | Execuções | Recuperadas | Maior tempo (s) | Máx. tentativas |
| --- | --- | --- | --- | --- | --- |
${POINTS.map(p => `| ${p} | ${label[p]} | ${byPoint[p].runs} | ${byPoint[p].recovered} | ${byPoint[p].maxSeconds} | ${byPoint[p].maxAttempts} |`).join('\n')}

| Execução | Ponto | Estado | Tentativas | Pacotes | Versões | Verificado | Segundos após restauração | Resultado |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${runs.map(r => `| ${r.index} | ${r.point} | ${r.status} | ${r.attempts} | ${r.packages} | ${r.versions} | ${r.verified ? 'sim' : 'não'} | ${r.secondsAfterRestore} | ${r.pass ? 'ok' : 'FALHA'} |`).join('\n')}
`);
  console.log(`VERDICT ${result.verdict} recuperadas ${result.summary.recovered}/30 maior ${result.summary.maxSecondsAfterRestore}s`);
  process.exitCode = verdict ? 0 : 1;
} catch (error) {
  console.log('ERROR ' + (error.stack ?? error));
  await writeFile(`${SIGNALS}/finished`, 'error').catch(() => undefined);
  process.exitCode = 2;
} finally {
  server.closeAllConnections(); server.close();
  await Promise.allSettled([auth.close(), persistence.close(), accounts.close(), transactions.close(), documents.close(), preview.close(), deliveries.close()]);
  await rm(work, { recursive: true, force: true });
  process.exit();
}
