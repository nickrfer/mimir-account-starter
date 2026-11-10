import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { adminClient, client, environment, identity, sha, sleep, startApi, writeResult } from './lib/harness.mjs';

const run = promisify(execFile);
const BYTE_CODES = ['FILE_HASH_MISMATCH', 'FILE_SIZE_MISMATCH', 'MANIFEST_BYTES_MISMATCH'];
const ABSENCE_CODES = ['MISSING_FILE', 'MANIFEST_MISSING', 'MISSING_REQUIRED_ARTIFACTS'];
const EXTRA_CODES = ['EXTRA_FILE', 'SPECIAL_FILE_FORBIDDEN', 'SYMLINK_FORBIDDEN'];
const CLASS_CODES = { alteracao: BYTE_CODES, ausencia: ABSENCE_CODES, extra: EXTRA_CODES };
const STRUCTURAL = new Set([...BYTE_CODES, ...ABSENCE_CODES, ...EXTRA_CODES]);

function readZip(bytes) {
  const end = bytes.length - 22, count = bytes.readUInt16LE(end + 10), entries = new Map(); let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = bytes.readUInt16LE(at + 10), csize = bytes.readUInt32LE(at + 20), nameLength = bytes.readUInt16LE(at + 28), offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8'), start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const raw = bytes.subarray(start, start + csize); entries.set(name, method === 8 ? inflateRawSync(raw) : raw);
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return entries;
}

async function verify(dir, reference) {
  try { const r = await run(process.execPath, ['packages/verifier/dist/index.js', dir, reference]); return { exit: 0, line: r.stdout.trim() }; }
  catch (e) { return { exit: e.code ?? null, line: String(e.stderr || e.stdout).trim() }; }
}

const invalidRuns = JSON.parse(await readFile('tools/avaliacao/execucoes-invalidas.json', 'utf8')).C04 ?? [];
const admin = await adminClient(), env = await environment(admin), api = await startApi();
const work = await mkdtemp(join(tmpdir(), 'mimir-c04-'));
const fail = message => { throw new Error(message); };
try {
  const A = await identity(api, 'Synthetic C04 A'), a = client(api, await A.login());
  const rev = async () => Number((await admin.query('SELECT revision::text n FROM mimir.workspaces WHERE id=$1', [A.workspaceId])).rows[0].n);
  const ok = (r, code) => { if (r.status !== code) fail(`setup ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  const account = async type => ok(await a.request('POST', '/accounts', { name: `Conta ${type}`, accountType: type, expectedRevision: await rev() }), 201).account.id;
  const pf = await account('PF'), pj = await account('PJ');
  const tx = async (accountId, fields) => ok(await a.request('POST', '/transactions', { accountId, direction: 'SAIDA', amountCents: 10000, description: 'Synthetic C04', category: 'GERAL',
    classification: 'DESPESA', isPfBusinessExpense: false, explanation: '', ...fields, expectedRevision: await rev() }), 201).transaction.transactionId;
  const upload = async (id, bytes, name, type) => { const f = new FormData(); f.append('file', new Blob([bytes], { type }), name); f.append('expectedRevision', String(await rev()));
    return ok(await a.request('POST', `/transactions/${id}/documents`, f), 201).documentId; };
  const pdf = label => Buffer.from(`%PDF-1.7\nSynthetic C04 ${label}\n${'x'.repeat(300)}\n%%EOF\n`);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('Synthetic C04 PNG body '.repeat(10))]);
  const expense = await tx(pf, { occurredOn: '2026-10-10', isPfBusinessExpense: true, description: 'Hospedagem paga na PF' });
  const revenue = await tx(pj, { occurredOn: '2026-10-12', direction: 'ENTRADA', classification: 'RECEITA', amountCents: 250000, description: 'Serviço prestado', category: 'SERVICOS' });
  await tx(pj, { occurredOn: '2026-10-15', amountCents: 500, description: 'Tarifa sem comprovante', category: 'TARIFAS' });
  const outflow = await tx(pj, { occurredOn: '2026-11-05', classification: 'TRANSFERENCIA', description: 'Reembolso ao sócio', category: 'TRANSFERENCIAS' });
  const inflow = await tx(pf, { occurredOn: '2026-11-05', direction: 'ENTRADA', classification: 'TRANSFERENCIA', description: 'Entrada do reembolso', category: 'TRANSFERENCIAS' });
  const docExpense = await upload(expense, pdf('origem'), 'nota.pdf', 'application/pdf');
  const docRevenue = await upload(revenue, png, 'recibo.png', 'image/png');
  const docContext = await upload(outflow, pdf('pix'), 'pix.pdf', 'application/pdf');
  ok(await a.request('POST', '/reimbursements', { pfExpenseTransactionId: expense, pjReimbursementTransactionId: outflow, pfInflowTransactionId: inflow, notes: '', expectedRevision: await rev() }), 201);
  const capture = ok(await a.request('POST', '/deliveries', { periodMonth: '2026-10', expectedRevision: await rev(), rectificationReason: '' }, { 'Idempotency-Key': `c04-${Date.now()}-capture` }), 202);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { ready = (await a.request('GET', `/operations/${capture.id}`)).json?.status === 'PRONTA'; if (!ready) await sleep(200); }
  if (!ready) fail('entrega não ficou PRONTA');
  const reference = (await a.request('GET', `/deliveries/${capture.snapshotId}/manifest`)).raw;
  const zipBytes = (await a.request('GET', `/deliveries/${capture.snapshotId}/package`)).raw;
  const base = join(work, 'base'), referencePath = join(work, 'referencia.manifesto.json');
  for (const [name, data] of readZip(zipBytes)) { await mkdir(dirname(join(base, name)), { recursive: true }); await writeFile(join(base, name), data); }
  await writeFile(referencePath, reference);
  const manifest = JSON.parse(reference.toString('utf8'));
  const attachment = id => manifest.files.find(f => f.documentId === id).path;
  if (!manifest.files.find(f => f.documentId === docContext)?.inclusionReasons.includes('CONTEXTO_REEMBOLSO')) fail('anexo de contexto ausente do pacote base');

  const cases = [];
  async function check(id, klass, description, mutate, { lab = null, expectExit = 1, allowed = null } = {}) {
    const dir = join(work, id); await cp(base, dir, { recursive: true, verbatimSymlinks: true });
    let ref = referencePath;
    if (lab) {
      const changed = structuredClone(manifest); lab(changed);
      const bytes = Buffer.from(JSON.stringify(changed, null, 2) + '\n', 'utf8');
      ref = join(work, `${id}.ref.json`); await writeFile(ref, bytes); await writeFile(join(dir, 'manifesto.json'), bytes);
    }
    if (mutate) await mutate(dir);
    const v = await verify(dir, ref), code = /^([A-Z_]+):/.exec(v.line)?.[1] ?? null;
    const codeOk = allowed ? allowed.includes(code) : klass === 'referencia' ? code !== null && !STRUCTURAL.has(code) : true;
    const pass = v.exit === expectExit && (expectExit === 0 || codeOk);
    cases.push({ id, class: klass, description, expectedExit: expectExit, observedExit: v.exit, code, codeCoherent: codeOk, pass });
    if (!pass) console.log(`CASE-FAIL ${id} ${description}: exit ${v.exit} ${v.line}`);
  }
  const flip = (path, at = -2) => async dir => { const p = join(dir, path), b = await readFile(p); const i = at < 0 ? b.length + at : at; b[i] ^= 0x01; await writeFile(p, b); };
  const replaceText = (path, from, to) => async dir => { const p = join(dir, path), t = await readFile(p, 'utf8'); if (!t.includes(from)) fail(`texto ausente em ${path}`); await writeFile(p, t.replace(from, to)); };
  const remove = path => async dir => unlink(join(dir, path));
  const add = (path, data = 'extra') => async dir => { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), data); };
  const C = (klass) => ({ allowed: CLASS_CODES[klass] });

  await check('C+', 'controle', 'Pacote íntegro com referência externa', null, { expectExit: 0 });
  await check('A1', 'alteracao', '1 byte de anexo PDF', flip(attachment(docExpense)), C('alteracao'));
  await check('A2', 'alteracao', '1 byte de anexo PNG', flip(attachment(docRevenue)), C('alteracao'));
  await check('A3', 'alteracao', 'Texto do resumo.html', replaceText('resumo.html', 'Serviço prestado', 'Servico prestadx'), C('alteracao'));
  await check('A4', 'alteracao', 'Valor no movimentacoes.csv', replaceText('movimentacoes.csv', '250000', '250001'), C('alteracao'));
  await check('A5', 'alteracao', 'Campo do manifesto.json dentro do pacote', replaceText('manifesto.json', 'Synthetic C04 A', 'Synthetic C04 B'), C('alteracao'));
  await check('F1', 'ausencia', 'Anexo removido', remove(attachment(docExpense)), C('ausencia'));
  await check('F2', 'ausencia', 'resumo.html removido', remove('resumo.html'), C('ausencia'));
  await check('F3', 'ausencia', 'movimentacoes.csv removido', remove('movimentacoes.csv'), C('ausencia'));
  await check('F4', 'ausencia', 'Anexo de contexto de reembolso removido', remove(attachment(docContext)), C('ausencia'));
  await check('F5', 'ausencia', 'manifesto.json removido do pacote', remove('manifesto.json'), C('ausencia'));
  await check('E1', 'extra', 'Arquivo extra em anexos/', add(`anexos/${randomUUID()}.pdf`, '%PDF-1.7\nextra\n%%EOF\n'), C('extra'));
  await check('E2', 'extra', 'Arquivo extra na raiz', add('leia-me.txt'), C('extra'));
  await check('E3', 'extra', 'Subdiretório novo com arquivo', add('outros/nota.txt'), C('extra'));
  await check('E4', 'extra', 'Cópia de anexo com outro nome', async dir => cp(join(dir, attachment(docExpense)), join(dir, 'anexos/copia-nota.pdf')), C('extra'));
  await check('E5', 'extra', 'Link simbólico no pacote', async dir => symlink(join(dir, 'resumo.html'), join(dir, 'atalho.html')), C('extra'));
  const ghost = randomUUID();
  await check('R1', 'referencia', 'Documento referenciado inexistente', null, { lab: m => { m.transactions.find(t => t.transactionId === revenue).documentIds.push(ghost); } });
  await check('R2', 'referencia', 'Vínculo de reembolso para lançamento ausente', null, { lab: m => { m.reimbursementLinks[0].pjReimbursementTransactionId = randomUUID(); } });
  await check('R3', 'referencia', 'Pendência para lançamento ausente', null, { lab: m => { m.pendingItems[0].transactionId = randomUUID(); } });
  await check('R4', 'referencia', 'categoryTotals incoerente', null, { lab: m => { m.summary.categoryTotals[0].outflowCents += 1; } });
  await check('R5', 'referencia', 'Arquivo com papel trocado', null, { lab: m => { const h = m.files.find(f => f.path === 'resumo.html'), c = m.files.find(f => f.path === 'movimentacoes.csv'); [h.role, c.role] = [c.role, h.role]; } });
  {
    const dir = join(work, 'C-lim'); await cp(base, dir, { recursive: true });
    const p = join(dir, attachment(docExpense)), b = await readFile(p); b[b.length - 2] ^= 0x01; await writeFile(p, b);
    const changed = structuredClone(manifest); changed.files.find(x => x.documentId === docExpense).sha256 = sha(b);
    const forged = Buffer.from(JSON.stringify(changed, null, 2) + '\n', 'utf8');
    await writeFile(join(dir, 'manifesto.json'), forged);
    const untrusted = join(work, 'referencia-nao-confiavel.json'); await writeFile(untrusted, forged);
    const own = await verify(dir, join(dir, 'manifesto.json')), ownCode = /^([A-Z_]+):/.exec(own.line)?.[1] ?? null;
    cases.push({ id: 'C-auto', class: 'controle-adicional', description: 'Referência apontando para o manifesto dentro do próprio pacote (autorreferência)', expectedExit: 2, observedExit: own.exit, code: ownCode, codeCoherent: ownCode === 'EXTERNAL_REFERENCE_REQUIRED', pass: own.exit === 2 });
    const v = await verify(dir, untrusted), code = /^([A-Z_]+):/.exec(v.line)?.[1] ?? null;
    cases.push({ id: 'C-lim', class: 'limitacao', description: 'Anexo alterado, hash ajustado no manifesto do pacote e cópia dele fora do pacote usada como referência não confiável', expectedExit: 0, observedExit: v.exit, code, codeCoherent: true, pass: v.exit === 0 });
  }
  const mutations = cases.filter(c => ['alteracao', 'ausencia', 'extra', 'referencia'].includes(c.class));
  const controls = cases.filter(c => !mutations.includes(c));
  const verdict = mutations.length === 20 && mutations.every(c => c.pass) && controls.every(c => c.pass);
  const byClass = Object.fromEntries(['alteracao', 'ausencia', 'extra', 'referencia'].map(k => [k, `${mutations.filter(c => c.class === k && c.pass).length}/${mutations.filter(c => c.class === k).length}`]));
  const result = { ...env, finishedAt: new Date().toISOString(), criterion: 'Detectar os 20 casos de alteração, ausência, arquivo extra ou referência inválida com referência confiável externa; controle íntegro aceito; limitação sem referência confiável documentada (RNF-04).',
    package: { files: manifest.files.length, transactions: manifest.transactions.length, contextTransactions: manifest.contextTransactions.length, reimbursementLinks: manifest.reimbursementLinks.length, pendingItems: manifest.pendingItems.length },
    summary: { mutations: mutations.length, detected: mutations.filter(c => c.pass).length, byClass, controls: controls.map(c => ({ id: c.id, pass: c.pass })), invalidRuns: invalidRuns.length },
    invalidRuns,
    verdict: verdict ? 'ATENDE' : 'NAO_ATENDE', cases };
  const row = c => `| ${c.id} | ${c.class} | ${c.description} | ${c.expectedExit} | ${c.observedExit} | ${c.code ?? '-'} | ${c.pass ? 'ok' : 'FALHA'} |`;
  await writeResult(result, `# Resultado C04 - Integridade e rastreabilidade (RNF-04)

Veredito: **${verdict ? 'atende' : 'não atende'}** ao critério: ${result.criterion}

- Commit \`${env.commit}\` (tag \`poc-v1.0.0\`; produto igual à tag: ${env.productEqualToTag ? 'sim' : 'não'}); projeto \`${env.project}\`; Docker ${env.docker}; PostgreSQL ${env.postgres}; Node ${env.node}.
- Pacote base: entrega real de 2026-10 (API com executor embutido), ${result.package.files} arquivos, ${result.package.transactions} movimentações, ${result.package.contextTransactions} de contexto de reembolso, ${result.package.reimbursementLinks} vínculo, ${result.package.pendingItems} pendências. Referência confiável: \`GET /deliveries/{id}/manifest\`, guardada fora do pacote.
- Verificador: CLI \`packages/verifier/dist/index.js <pacote> <referência>\` em processo separado. Exit esperado 1 nas mutações, com diagnóstico coerente com a classe (fixado antes da execução).
- Detectadas: ${result.summary.detected}/${result.summary.mutations} (alteração ${byClass.alteracao}, ausência ${byClass.ausencia}, extra ${byClass.extra}, referência ${byClass.referencia}).
- C-auto (observação adicional): apontar a referência para o manifesto dentro do pacote é recusado com exit 2 (\EXTERNAL_REFERENCE_REQUIRED\).
- C-lim é a limitação esperada: uma cópia do manifesto adulterado, fora do pacote e apresentada como referência, é aceita. A garantia depende de a referência vir de canal confiável, como já declarado no resumo e na documentação.
- Execuções substituídas por defeito do harness: ${invalidRuns.length}${invalidRuns.map(r => `\n  - \`\`: ${r.reason}`).join('')}

| Caso | Classe | Mutação | Exit esperado | Exit observado | Diagnóstico | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
${cases.map(row).join('\n')}
`);
  console.log(`VERDICT ${result.verdict} detectadas ${result.summary.detected}/${result.summary.mutations} controles ${controls.map(c => `${c.id}:${c.pass ? 'ok' : 'falha'}`).join(' ')}`);
  process.exitCode = verdict ? 0 : 1;
} catch (error) {
  console.log('ERROR ' + (error.stack ?? error));
  process.exitCode = 2;
} finally {
  await api.stop(); await admin.end(); await rm(work, { recursive: true, force: true });
}
