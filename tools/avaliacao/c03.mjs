import { adminClient, client, environment, identity, sleep, startApi, writeResult } from './lib/harness.mjs';

const MONTH = '2026-10';
const pdf = label => new Blob([Buffer.from(`%PDF-1.7\nSynthetic C03 ${label}\n%%EOF\n`)], { type: 'application/pdf' });
const form = (fields, file, name = 'c03.pdf') => { const f = new FormData(); if (file) f.append('file', file, name); for (const [k, v] of Object.entries(fields)) f.append(k, String(v)); return f; };

const admin = await adminClient(), env = await environment(admin), api = await startApi();
const fail = message => { throw new Error(message); };
try {
  const A = await identity(api, 'Synthetic C03 A'), B = await identity(api, 'Synthetic C03 B');
  const a1 = client(api, await A.login()), a2 = client(api, await A.login()), b = client(api, await B.login()), anon = client(api, null);
  const revoked = await A.login(), revokedClient = client(api, revoked);
  if ((await revokedClient.request('DELETE', '/session')).status !== 204) fail('revogar sessão');
  const rev = async who => Number((await admin.query('SELECT revision::text n FROM mimir.workspaces WHERE id=$1', [who.workspaceId])).rows[0].n);
  const ok = (r, ...codes) => { if (!codes.includes(r.status)) fail(`setup ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  async function seed(who, c) {
    const account = async type => ok(await c.request('POST', '/accounts', { name: `Conta ${type} ${who.label}`, accountType: type, expectedRevision: await rev(who) }), 201).account.id;
    const pf = await account('PF'), pj = await account('PJ');
    const tx = async (accountId, extra) => ok(await c.request('POST', '/transactions', { accountId, occurredOn: `${MONTH}-10`, direction: 'SAIDA', amountCents: 10000, description: 'Synthetic C03',
      category: 'GERAL', classification: 'DESPESA', isPfBusinessExpense: false, explanation: '', ...extra, expectedRevision: await rev(who) }), 201).transaction.transactionId;
    const main = await tx(pj), noDoc = await tx(pj), pfExpense = await tx(pf, { isPfBusinessExpense: true }), outflow = await tx(pj, { classification: 'TRANSFERENCIA', occurredOn: `${MONTH}-20` });
    const doc = ok(await c.request('POST', `/transactions/${main}/documents`, form({ expectedRevision: await rev(who) }, pdf(who.label))), 201).documentId;
    const pending = (await admin.query(`SELECT id FROM mimir.pending_items WHERE transaction_id=$1 AND type='DOCUMENTO_AUSENTE'`, [noDoc])).rows[0].id;
    return { pf, pj, main, noDoc, pfExpense, outflow, doc, pending };
  }
  const objA = await seed(A, a1), objB = await seed(B, b);
  const captureKey = `c03-${Date.now()}-capture`;
  const capture = ok(await a1.request('POST', '/deliveries', { periodMonth: MONTH, expectedRevision: await rev(A), rectificationReason: '' }, { 'Idempotency-Key': captureKey }), 202);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { ready = (await a1.request('GET', `/operations/${capture.id}`)).json?.status === 'PRONTA'; if (!ready) await sleep(200); }
  if (!ready) fail('entrega de A não ficou PRONTA');
  objA.operation = capture.id; objA.snapshot = capture.snapshotId;

  const tables = ['transactions', 'documents', 'transaction_documents', 'pending_items', 'reimbursement_links', 'delivery_operations', 'import_origins'];
  async function state(who) {
    const counts = {};
    for (const table of tables) counts[table] = (await admin.query(`SELECT count(*)::int n FROM mimir.${table} WHERE workspace_id=$1`, [who.workspaceId])).rows[0].n;
    const fingerprint = (await admin.query(`SELECT md5(string_agg(t.id::text||t.status||t.amount_cents||t.description||t.account_id, ',' ORDER BY t.id)) f FROM mimir.transactions t WHERE workspace_id=$1`, [who.workspaceId])).rows[0].f;
    const pend = (await admin.query(`SELECT md5(string_agg(id::text||status||justification, ',' ORDER BY id)) f FROM mimir.pending_items WHERE workspace_id=$1`, [who.workspaceId])).rows[0].f;
    return JSON.stringify({ revision: await rev(who), counts, fingerprint, pend });
  }
  const leaks = r => { const text = r.raw.toString('utf8'); return Object.values(objA).filter(v => typeof v === 'string' && text.includes(v)); };
  const replace = (c, txId, replaced, revision) => c.request('POST', `/transactions/${txId}/document-replacements`, form({ replacedDocumentId: replaced, expectedRevision: revision }, pdf('novo')));
  const link = (c, txId, documentId, revision) => c.request('POST', `/transactions/${txId}/document-links`, { documentId, expectedRevision: revision });
  const deliver = (c, revision, key = `c03-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`) =>
    c.request('POST', '/deliveries', { periodMonth: MONTH, expectedRevision: revision, rectificationReason: 'Nova versão C03' }, { 'Idempotency-Key': key });
  const notOperationOfA = r => r.json?.id !== objA.operation && r.json?.snapshotId !== objA.snapshot;
  const ra = async () => rev(A), rb = async () => rev(B);

  const ops = [
    { op: 'GET /transactions/{id}', call: c => c.request('GET', `/transactions/${objA.main}`), n3: async () => ({ r: await b.request('GET', `/transactions?periodMonth=${MONTH}`), expect: 200 }), positive: 200, reader: true },
    { op: 'PATCH /transactions/{id}', call: async c => c.request('PATCH', `/transactions/${objA.main}`, { description: 'Alterada C03', expectedRevision: await ra() }),
      n2: async () => b.request('PATCH', `/transactions/${objA.main}`, { description: 'Alterada C03', expectedRevision: await ra() }),
      n3: async () => ({ r: await b.request('PATCH', `/transactions/${objB.main}`, { accountId: objA.pj, expectedRevision: await rb() }), expect: 404 }), positive: 200 },
    { op: 'DELETE /transactions/{id}', call: async c => c.request('DELETE', `/transactions/${objA.noDoc}`, { expectedRevision: await ra() }),
      n2: async () => b.request('DELETE', `/transactions/${objA.noDoc}`, { expectedRevision: await ra() }),
      n3: async () => ({ r: await b.request('POST', '/transactions', { accountId: objA.pj, occurredOn: `${MONTH}-11`, direction: 'SAIDA', amountCents: 1, description: 'x', category: 'x',
        classification: 'DESPESA', isPfBusinessExpense: false, explanation: '', expectedRevision: await rb() }), expect: 404 }), positive: 200, last: true },
    { op: 'POST /transactions/{id}/documents', call: async c => c.request('POST', `/transactions/${objA.main}/documents`, form({ expectedRevision: await ra() }, pdf('upload'))),
      n2: async () => b.request('POST', `/transactions/${objA.main}/documents`, form({ expectedRevision: await ra() }, pdf('upload'))),
      n3: async () => ({ r: await replace(b, objB.main, objA.doc, await rb()), expect: 404 }), positive: 201 },
    { op: 'GET /documents/{id}/content', call: c => c.request('GET', `/documents/${objA.doc}/content`), n3: async () => ({ r: await b.request('GET', `/documents?periodMonth=${MONTH}`), expect: 200 }), positive: 200, reader: true },
    { op: 'POST /transactions/{id}/document-links', call: async c => link(c, objA.pfExpense, objA.doc, await ra()),
      n2: async () => link(b, objA.pfExpense, objA.doc, await ra()), n3: async () => ({ r: await link(b, objB.main, objA.doc, await rb()), expect: 404 }), positive: 201 },
    { op: 'PATCH /pending-items/{id}', call: async c => c.request('PATCH', `/pending-items/${objA.pending}`, { action: 'JUSTIFY', justification: 'Justificativa C03', expectedRevision: await ra() }),
      n2: async () => b.request('PATCH', `/pending-items/${objA.pending}`, { action: 'JUSTIFY', justification: 'Justificativa C03', expectedRevision: await ra() }),
      n3: async () => ({ r: await b.request('GET', `/pending-items?periodMonth=${MONTH}`), expect: 200 }), positive: 200 },
    { op: 'GET /periods/{m}/preview', call: c => c.request('GET', `/periods/${MONTH}/preview`), n2: async () => b.request('GET', `/periods/${MONTH}/preview`), n2Expect: 200,
      n3: async () => ({ r: await b.request('POST', `/transactions/${objA.main}/questions`, { description: 'Dúvida C03', expectedRevision: await rb() }), expect: 404 }), positive: 200, reader: true },
    { op: 'GET /operations/{id}', call: c => c.request('GET', `/operations/${objA.operation}`), n3: async () => ({ r: await b.request('GET', `/periods/${MONTH}/deliveries`), expect: 200 }), positive: 200, reader: true },
    { op: 'GET /deliveries/{id}/package', call: c => c.request('GET', `/deliveries/${objA.snapshot}/package`),
      n3: async () => ({ r: await b.request('GET', `/deliveries/${objA.snapshot}/manifest`), expect: 404 }), positive: 200, reader: true },
    { op: 'POST /reimbursements', call: async c => c.request('POST', '/reimbursements', { pfExpenseTransactionId: objA.pfExpense, pjReimbursementTransactionId: objA.outflow, pfInflowTransactionId: null, notes: '', expectedRevision: await ra() }),
      n2: async () => b.request('POST', '/reimbursements', { pfExpenseTransactionId: objA.pfExpense, pjReimbursementTransactionId: objA.outflow, pfInflowTransactionId: null, notes: '', expectedRevision: await rb() }),
      n3: async () => ({ r: await b.request('POST', '/reimbursements', { pfExpenseTransactionId: objB.pfExpense, pjReimbursementTransactionId: objA.outflow, pfInflowTransactionId: null, notes: '', expectedRevision: await rb() }), expect: 404 }), positive: 201 },
    { op: 'POST /deliveries', call: async c => deliver(c, await ra()),
      n2Case: async () => ({ r: await deliver(b, await rb()), expect: 202, onlyA: true, check: notOperationOfA }),
      n3: async () => ({ r: await deliver(b, await rb(), captureKey), expect: 202, onlyA: true, check: notOperationOfA }), positive: 202 },
  ];

  const cases = [];
  async function negative(op, condition, run) {
    const before = [await state(A), await state(B)];
    let out = null, error = null;
    try { out = await run(); } catch (e) { error = String(e.message ?? e); }
    const after = [await state(A), await state(B)];
    const r = out?.r, expected = out?.expect ?? null, leaked = r ? leaks(r) : [];
    const unchanged = before[0] === after[0] && (out?.onlyA || before[1] === after[1]);
    const pass = !error && r.status === expected && unchanged && leaked.length === 0 && (!out?.check || out.check(r));
    cases.push({ op: op.op, kind: 'negativo', condition, expected, observed: r?.status ?? null, code: r?.json?.code ?? null, unchanged, leakedIds: leaked.length, pass, error });
    if (!pass) console.log(`CASE-FAIL ${condition} ${op.op}: esperado ${expected}, observado ${r?.status} unchanged=${unchanged} leak=${leaked.length} ${error ?? ''}`);
  }
  for (const op of ops) {
    await negative(op, 'N1-sem-sessao', async () => ({ r: await op.call(anon), expect: 401 }));
    await negative(op, 'N1-sessao-revogada', async () => ({ r: await op.call(revokedClient), expect: 401 }));
    await negative(op, 'N2-outro-proprietario', op.n2Case ?? (async () => ({ r: await (op.n2 ? op.n2() : op.call(b)), expect: op.n2Expect ?? 404 })));
    await negative(op, 'N3-vinculo-entre-espacos', op.n3);
  }
  for (const op of [...ops.filter(op => !op.last), ...ops.filter(op => op.last)]) {
    const who = op.reader ? a2 : a1;
    const r = await op.call(who);
    const pass = r.status === op.positive;
    cases.push({ op: op.op, kind: 'positivo', condition: op.reader ? 'A2-segunda-sessao' : 'A1', expected: op.positive, observed: r.status, code: r.json?.code ?? null, pass });
    if (!pass) console.log(`CASE-FAIL positivo ${op.op}: esperado ${op.positive}, observado ${r.status} ${JSON.stringify(r.json)}`);
  }

  const negatives = cases.filter(c => c.kind === 'negativo'), positives = cases.filter(c => c.kind === 'positivo');
  const core = negatives.filter(c => c.condition !== 'N1-sessao-revogada');
  const verdict = core.length === 36 && core.every(c => c.pass) && positives.length === 12 && positives.every(c => c.pass) && negatives.every(c => c.pass);
  const result = { ...env, finishedAt: new Date().toISOString(), criterion: 'Bloquear os 36 casos negativos (12 operações × 3 condições) com 12 controles positivos aceitos, sem vazamento nem mutação (RNF-03).',
    summary: { negatives: core.length, negativesBlocked: core.filter(c => c.pass).length, extraRevokedSession: negatives.length - core.length, extraRevokedSessionBlocked: negatives.filter(c => c.condition === 'N1-sessao-revogada' && c.pass).length,
      positives: positives.length, positivesAccepted: positives.filter(c => c.pass).length, invalidRuns: 0 }, verdict: verdict ? 'ATENDE' : 'NAO_ATENDE', cases };
  const row = c => `| ${c.op} | ${c.condition} | ${c.expected} | ${c.observed ?? '-'}${c.code ? ` ${c.code}` : ''} | ${c.unchanged === undefined ? '-' : c.unchanged ? 'sim' : 'não'} | ${c.pass ? 'ok' : 'FALHA'} |`;
  const md = `# Resultado C03 - Segurança e isolamento (RNF-03)

Veredito: **${result.verdict === 'ATENDE' ? 'atende' : 'não atende'}** ao critério: ${result.criterion}

- Commit \`${env.commit}\` (tag \`poc-v1.0.0\`; produto igual à tag: ${env.productEqualToTag ? 'sim' : 'não'}); projeto Docker \`${env.project}\`; Docker ${env.docker}; PostgreSQL ${env.postgres}; Node ${env.node}.
- API: ponto de entrada real (\`apps/api/dist/index.js\`, executor embutido) em processo filho com apenas as variáveis de runtime; identidades A (sessões A1, A2) e B independentes; CSRF válido em todas as mutações.
- Negativos: ${result.summary.negativesBlocked}/${result.summary.negatives} bloqueados (N1 sem sessão, N2 outro proprietário, N3 vínculo entre espaços); adicional N1 com sessão revogada: ${result.summary.extraRevokedSessionBlocked}/${result.summary.extraRevokedSession}.
- Positivos: ${result.summary.positivesAccepted}/${result.summary.positives} aceitos.
- "Inalterado" compara revisão, contagens e conteúdo dos dois espaços antes e depois de cada caso negativo. Em \`POST /deliveries\` o comando não referencia objeto de A: N2 é B capturando o próprio mês e N3 é B reutilizando a \`Idempotency-Key\` da captura de A; em ambos só A precisa ficar inalterado, e a resposta não pode ser a operação de A.
- Matriz da §4 do protocolo (repetição após a errata E4); a execução anterior, com duas operações trocadas, está em \`resultados/historico/\`.

| Operação | Condição | Esperado | Observado | Inalterado | Resultado |
| --- | --- | --- | --- | --- | --- |
${cases.map(row).join('\n')}
`;
  await writeResult(result, md);
  console.log(`VERDICT ${result.verdict} negativos ${result.summary.negativesBlocked}/${result.summary.negatives} positivos ${result.summary.positivesAccepted}/${result.summary.positives}`);
  process.exitCode = verdict ? 0 : 1;
} catch (error) {
  console.log('ERROR ' + (error.stack ?? error));
  process.exitCode = 2;
} finally {
  await api.stop(); await admin.end();
}
