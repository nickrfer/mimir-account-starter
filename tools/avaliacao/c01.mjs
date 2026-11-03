import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import pg from 'pg';
import { adminClient, client, environment, identity, sleep, startApi, writeResult } from './lib/harness.mjs';

const run = promisify(execFile);
const MONTH = '2026-10', PER_TYPE = 25, MUTATION_FIRST = 12;
const BLOCKS = ['workspace', 'summary', 'transactions', 'contextTransactions', 'reimbursementLinks', 'pendingItems'];
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const view = source => canonical(Object.fromEntries(BLOCKS.map(k => [k, source[k]])));

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

const invalidRuns = JSON.parse(await readFile('tools/avaliacao/execucoes-invalidas.json', 'utf8')).C01 ?? [];
const admin = await adminClient(), env = await environment(admin), api = await startApi();
const work = await mkdtemp(join(tmpdir(), 'mimir-c01-'));
const fail = message => { throw new Error(message); };
const locker = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL }); await locker.connect();
const watcher = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL }); await watcher.connect();

async function verifyPackage(zip, manifest, tag) {
  const dir = join(work, tag); await rm(dir, { recursive: true, force: true });
  for (const [name, data] of readZip(zip)) { await mkdir(dirname(join(dir, name)), { recursive: true }); await writeFile(join(dir, name), data); }
  const ref = join(work, `${tag}.ref.json`); await writeFile(ref, manifest);
  try { await run(process.execPath, ['packages/verifier/dist/index.js', dir, ref]); return true; } catch { return false; }
}

async function lockWaiters() {
  return (await watcher.query('SELECT count(DISTINCT pid)::int n FROM pg_locks WHERE NOT granted AND pid<>$1', [locker.processID])).rows[0].n;
}

async function scenario(index, type, mutationFirst) {
  const A = await identity(api, `Synthetic C01 ${index}`), a = client(api, await A.login());
  const rev = async () => Number((await admin.query('SELECT revision::text n FROM mimir.workspaces WHERE id=$1', [A.workspaceId])).rows[0].n);
  const ok = (r, ...codes) => { if (!codes.includes(r.status)) fail(`setup ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  const account = async t => ok(await a.request('POST', '/accounts', { name: `Conta ${t}`, accountType: t, expectedRevision: await rev() }), 201).account.id;
  const pf = await account('PF'), pj = await account('PJ');
  const tx = async (accountId, fields) => ok(await a.request('POST', '/transactions', { accountId, occurredOn: `${MONTH}-10`, direction: 'SAIDA', amountCents: 10000, description: 'Synthetic C01',
    category: 'GERAL', classification: 'DESPESA', isPfBusinessExpense: false, explanation: '', ...fields, expectedRevision: await rev() }), 201).transaction.transactionId;
  const pdf = label => { const f = new FormData(); f.append('file', new Blob([Buffer.from(`%PDF-1.7\nSynthetic C01 ${label}\n%%EOF\n`)], { type: 'application/pdf' }), `${label}.pdf`); return f; };
  const upload = async (id, label, revision) => { const f = pdf(label); f.append('expectedRevision', String(revision ?? await rev())); return a.request('POST', `/transactions/${id}/documents`, f); };
  const revenue = await tx(pj, { direction: 'ENTRADA', classification: 'RECEITA', amountCents: 250000, category: 'SERVICOS' });
  const withDoc = await tx(pj, { amountCents: 3000, category: 'INFRA' });
  const noDoc = await tx(pj, { amountCents: 500, category: 'TARIFAS' });
  const pfExpense = await tx(pf, { isPfBusinessExpense: true, amountCents: 8000, category: 'INFRA' });
  const outflow = await tx(pj, { occurredOn: `${MONTH}-20`, classification: 'TRANSFERENCIA', amountCents: 8000, category: 'TRANSFERENCIAS' });
  await tx(pj, { occurredOn: `${MONTH}-21`, direction: 'ENTRADA', classification: 'TRANSFERENCIA', amountCents: 100, category: 'TRANSFERENCIAS' });
  ok(await upload(revenue, 'receita'), 201); ok(await upload(withDoc, 'infra'), 201); ok(await upload(pfExpense, 'pf'), 201);
  const pending = (await admin.query(`SELECT id FROM mimir.pending_items WHERE transaction_id=$1 AND type='DOCUMENTO_AUSENTE'`, [noDoc])).rows[0].id;

  async function capture(reason, revision) {
    return a.request('POST', '/deliveries', { periodMonth: MONTH, expectedRevision: revision ?? await rev(), rectificationReason: reason }, { 'Idempotency-Key': `c01-${index}-${reason.length}-${Date.now()}` });
  }
  async function ready(op) {
    for (let i = 0; i < 150; i++) { const s = (await a.request('GET', `/operations/${op.id}`)).json?.status; if (s === 'PRONTA') return true; if (s === 'FALHA') return false; await sleep(100); }
    return false;
  }
  const download = async (op, kind) => (await a.request('GET', `/deliveries/${op.snapshotId}/${kind}`)).raw;
  const v1 = ok(await capture(''), 202); if (!await ready(v1)) fail('v1 não ficou PRONTA');
  const v1Zip = await download(v1, 'package'), v1Manifest = await download(v1, 'manifest');
  const history = async () => (await a.request('GET', `/periods/${MONTH}/deliveries`)).json.items.length;
  const versionsBefore = await history();

  const R = await rev(), before = (await a.request('GET', `/periods/${MONTH}/preview`)).json;
  if (before.revision !== R) fail('prévia fora da revisão R');
  const mutation = {
    M1: () => a.request('PATCH', `/transactions/${withDoc}`, { amountCents: 3100, expectedRevision: R }),
    M2: () => upload(noDoc, 'novo', R),
    M3: () => a.request('POST', '/reimbursements', { pfExpenseTransactionId: pfExpense, pjReimbursementTransactionId: outflow, pfInflowTransactionId: null, notes: '', expectedRevision: R }),
    M4: () => a.request('PATCH', `/pending-items/${pending}`, { action: 'JUSTIFY', justification: 'Justificativa C01', expectedRevision: R }),
  }[type];

  await locker.query('BEGIN'); await locker.query('SELECT id FROM mimir.workspaces WHERE id=$1 FOR UPDATE', [A.workspaceId]);
  let captureResponse, mutationResponse;
  try {
    const first = mutationFirst ? () => (mutationResponse = mutation()) : () => (captureResponse = capture('Intercalação', R));
    const second = mutationFirst ? () => (captureResponse = capture('Intercalação', R)) : () => (mutationResponse = mutation());
    first(); for (let i = 0; i < 200 && await lockWaiters(A.workspaceId) < 1; i++) await sleep(5);
    second(); for (let i = 0; i < 200 && await lockWaiters(A.workspaceId) < 2; i++) await sleep(5);
    const queued = await lockWaiters(A.workspaceId);
    await locker.query('COMMIT');
    captureResponse = await captureResponse; mutationResponse = await mutationResponse;
    if (queued < 2) return { invalid: true, reason: `apenas ${queued} requisição(ões) enfileirada(s) no bloqueio` };
  } catch (error) { await locker.query('ROLLBACK').catch(() => undefined); throw error; }

  const captureAccepted = captureResponse.status === 202, mutationAccepted = [200, 201].includes(mutationResponse.status);
  const captureConflict = captureResponse.status === 409 && captureResponse.json?.code === 'REVISION_CONFLICT';
  const order = captureAccepted && mutationAccepted ? 'captura' : mutationAccepted && captureConflict ? 'mutacao' : 'invalida';
  const checks = { orderValid: order !== 'invalida' };
  let consistent = false, packageVerified = null, reflected = null, finalRevisionOk = false;
  if (order === 'captura') {
    const op = captureResponse.json; checks.capturePublished = await ready(op);
    const manifest = await download(op, 'manifest'), zip = await download(op, 'package'), parsed = JSON.parse(manifest.toString('utf8'));
    consistent = parsed.delivery.capturedRevision === R && view(parsed) === view(before);
    packageVerified = await verifyPackage(zip, manifest, `run${index}`);
    finalRevisionOk = await rev() === R + 1 && await history() === versionsBefore + 1;
  } else if (order === 'mutacao') {
    const after = (await a.request('GET', `/periods/${MONTH}/preview`)).json;
    finalRevisionOk = await rev() === R + 1 && after.revision === R + 1 && await history() === versionsBefore;
    const next = await capture('Após mutação');
    if (next.status === 202 && await ready(next.json)) {
      const manifest = JSON.parse((await download(next.json, 'manifest')).toString('utf8'));
      reflected = manifest.delivery.capturedRevision === R + 1 && view(manifest) === view(after) && view(after) !== view(before);
    } else reflected = false;
    consistent = reflected;
  }  const v1Preserved = (await download(v1, 'package')).equals(v1Zip) && (await download(v1, 'manifest')).equals(v1Manifest);
  const pass = checks.orderValid && consistent && v1Preserved && finalRevisionOk && (order !== 'captura' || (checks.capturePublished && packageVerified));
  return { index, type, queuedFirst: mutationFirst ? 'mutacao' : 'captura', attendedFirst: order,
    captureStatus: captureResponse.status, mutationStatus: mutationResponse.status, ...checks, consistent, packageVerified, reflected, v1Preserved, finalRevisionOk, pass };
}

try {
  const runs = [], invalid = [];
  let index = 0;
  for (const type of ['M1', 'M2', 'M3', 'M4']) {
    for (let i = 0; i < PER_TYPE; i++) {
      index++;
      let outcome = await scenario(index, type, i < MUTATION_FIRST);
      while (outcome.invalid) { if (invalid.length >= 10) throw new Error('mais de 10 execuções inválidas: harness com defeito'); invalid.push({ index, type, reason: outcome.reason }); console.log(`EVAL execução ${index} inválida: ${outcome.reason}; substituindo`); outcome = await scenario(index, type, i < MUTATION_FIRST); }
      runs.push(outcome);
      if (!outcome.pass) console.log(`CASE-FAIL ${index} ${type} ${JSON.stringify(outcome)}`);
      if (index % 10 === 0) console.log(`EVAL ${index}/100 concluídas; aprovadas ${runs.filter(r => r.pass).length}`);
    }
  }
  const verdict = runs.length === 100 && runs.every(r => r.pass);
  const byType = Object.fromEntries(['M1', 'M2', 'M3', 'M4'].map(t => [t, { runs: runs.filter(r => r.type === t).length, pass: runs.filter(r => r.type === t && r.pass).length,
    captureFirst: runs.filter(r => r.type === t && r.attendedFirst === 'captura').length, mutationFirst: runs.filter(r => r.type === t && r.attendedFirst === 'mutacao').length }]));
  const result = { ...env, finishedAt: new Date().toISOString(), criterion: 'Nenhuma mistura de revisões nas 100 intercalações controladas (25 por tipo de mutação): snapshot consistente ou 409, com bytes anteriores preservados (RNF-01).',
    summary: { runs: runs.length, pass: runs.filter(r => r.pass).length, mixed: runs.filter(r => !r.consistent).length, v1Preserved: runs.filter(r => r.v1Preserved).length, byType,
      substitutions: invalid.length + invalidRuns.length }, substitutions: [...invalidRuns, ...invalid], verdict: verdict ? 'ATENDE' : 'NAO_ATENDE', runs };
  const label = { M1: 'Correção de valor', M2: 'Upload de documento', M3: 'Vínculo de reembolso', M4: 'Justificativa de pendência' };
  await writeResult(result, `# Resultado C01 — Consistência da captura (RNF-01)

Veredito: **${verdict ? 'atende' : 'não atende'}** ao critério: ${result.criterion}

- Commit \`${env.commit}\` (tag \`poc-v1.0.0\`; produto igual à tag: ${env.productEqualToTag ? 'sim' : 'não'}); projeto \`${env.project}\`; Docker ${env.docker}; PostgreSQL ${env.postgres}; Node ${env.node}.
- Cada execução usa um espaço novo com 6 lançamentos, 3 documentos e 1 pendência, e uma entrega v1 publicada antes da intercalação. Com a linha do espaço bloqueada por uma conexão administrativa, captura e mutação são enviadas com a mesma revisão R, em ordem controlada (fila confirmada em \`pg_locks\`), e o bloqueio é liberado.
- Verificações conforme a errata E1 do protocolo (a captura não incrementa a revisão). Captura atendida primeiro: 202, manifesto igual (canonicalizado) à prévia em R, \`capturedRevision = R\`, pacote aprovado pelo CLI do verificador, mutação com R aceita em seguida e revisão final R+1. Mutação atendida primeiro: captura com R recusada com 409 \`REVISION_CONFLICT\`, nenhuma versão nova e captura seguinte igual à prévia em R+1. Em todas: v1 byte a byte igual.
- A execução anterior, com a verificação derivada incorreta, está mantida em \`resultados/historico/\`.
- Resultado: ${result.summary.pass}/${result.summary.runs} execuções corretas; misturas observadas: ${result.summary.mixed}; v1 preservada em ${result.summary.v1Preserved}/${result.summary.runs}. Substituições por defeito do harness: ${result.summary.substitutions}.

| Tipo | Mutação | Execuções | Corretas | Captura atendida primeiro | Mutação atendida primeiro |
| --- | --- | --- | --- | --- | --- |
${Object.entries(byType).map(([t, s]) => `| ${t} | ${label[t]} | ${s.runs} | ${s.pass} | ${s.captureFirst} | ${s.mutationFirst} |`).join('\n')}
`);
  console.log(`VERDICT ${result.verdict} corretas ${result.summary.pass}/${result.summary.runs} misturas ${result.summary.mixed}`);
  process.exitCode = verdict ? 0 : 1;
} catch (error) {
  console.log('ERROR ' + (error.stack ?? error));
  process.exitCode = 2;
} finally {
  await api.stop(); await admin.end(); await locker.end(); await watcher.end(); await rm(work, { recursive: true, force: true });
}
