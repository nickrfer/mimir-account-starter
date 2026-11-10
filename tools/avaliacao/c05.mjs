import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { adminClient, client, environment, identity, sha, sleep, startApi, writeResult } from './lib/harness.mjs';

const MONTH = '2026-10';
const RECORDS = [
  { date: '2026-10-01', account: 'PJ', direction: 'ENTRADA', classification: 'RECEITA', cents: 1, description: 'Receita mínima de 1 centavo', category: 'SERVIÇOS' },
  { date: '2026-10-02', account: 'PJ', direction: 'ENTRADA', classification: 'RECEITA', cents: 123456789, description: 'Consultoria - São Paulo/SP', category: 'SERVIÇOS', doc: 'NFS-e nº 123.pdf' },
  { date: '2026-10-03', account: 'PJ', direction: 'ENTRADA', classification: 'RECEITA', cents: 99999999999, description: 'Valor máximo permitido', category: 'SERVIÇOS' },
  { date: '2026-10-04', account: 'PJ', direction: 'SAIDA', classification: 'DESPESA', cents: 4590, description: 'Café & pão de queijo', category: 'ALIMENTAÇÃO', doc: 'cupom-café.pdf' },
  { date: '2026-10-05', account: 'PJ', direction: 'SAIDA', classification: 'DESPESA', cents: 12000, description: 'Ação "promocional", com vírgula', category: 'MARKETING' },
  { date: '2026-10-06', account: 'PJ', direction: 'SAIDA', classification: 'DESPESA', cents: 3300, description: '<b>Tag HTML</b> não interpretada', category: 'TARIFAS' },
  { date: '2026-10-07', account: 'PJ', direction: 'SAIDA', classification: 'DESPESA', cents: 777, description: '=SOMA(A1:A2) fórmula neutralizada', category: '+OUTROS' },
  { date: '2026-10-08', account: 'PJ', direction: 'SAIDA', classification: 'DESPESA', cents: 25000, description: 'Ônibus intermunicipal ÁÉÍÓÚ àèìòù ãõ ç', category: 'TRANSPORTE', doc: 'passagem.pdf' },
  { date: '2026-10-09', account: 'PJ', direction: 'SAIDA', classification: 'A_ESCLARECER', cents: 15050, description: 'Débito não identificado', category: 'A CLASSIFICAR', justify: 'Banco não informou o favorecido' },
  { date: '2026-10-10', account: 'PF', direction: 'SAIDA', classification: 'DESPESA', cents: 189900, description: 'Hospedagem paga no cartão do sócio', category: 'INFRAESTRUTURA', pf: true, doc: 'nota-hospedagem.pdf', reimburse: true },
  { date: '2026-10-11', account: 'PF', direction: 'ENTRADA', classification: 'RECEITA', cents: 50000, description: 'Receita pessoal fora do total da empresa', category: 'PESSOAL' },
  { date: '2026-10-12', account: 'PJ', direction: 'SAIDA', classification: 'TRANSFERENCIA', cents: 100000, description: 'Transferência entre contas PJ', category: 'TRANSFERÊNCIAS' },
  { date: '2026-10-13', account: 'PJ', direction: 'SAIDA', classification: 'DESPESA', cents: 990, description: 'Tarifa de manutenção', category: 'TARIFAS', justify: 'Extrato não traz comprovante individual' },
  { date: '2026-10-14', account: 'PJ', direction: 'SAIDA', classification: 'DESPESA', cents: 1000000, description: 'Equipamento - notebook', category: 'EQUIPAMENTOS', doc: 'nf-notebook.pdf' },
  { date: '2026-10-15', account: 'PJ', direction: 'ENTRADA', classification: 'RECEITA', cents: 75025, description: 'Receita com quebra\nde linha na descrição', category: 'SERVIÇOS' },
  { date: '2026-10-20', account: 'PJ', direction: 'SAIDA', classification: 'DESPESA', cents: 33333, description: 'Licença de software (anual)', category: 'SOFTWARE', doc: 'licença.pdf' },
  { date: '2026-10-25', account: 'PJ', direction: 'SAIDA', classification: 'DESPESA', cents: 6000, description: "Aspas simples 'teste' e apóstrofo d'água", category: 'OUTROS' },
  { date: '2026-10-28', account: 'PJ', direction: 'SAIDA', classification: 'DESPESA', cents: 2501, description: 'Imposto sobre serviço - ISS', category: 'IMPOSTOS' },
  { date: '2026-10-30', account: 'PJ', direction: 'ENTRADA', classification: 'TRANSFERENCIA', cents: 100000, description: 'Entrada de transferência PJ', category: 'TRANSFERÊNCIAS' },
  { date: '2026-10-31', account: 'PJ', direction: 'SAIDA', classification: 'DESPESA', cents: 4200, description: 'Último dia do mês', category: 'OUTROS' },
];

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

const admin = await adminClient(), env = await environment(admin), api = await startApi();
try {
  const A = await identity(api, 'Exemplo Sintético C05 Ltda'), a = client(api, await A.login());
  const rev = async () => Number((await admin.query('SELECT revision::text n FROM mimir.workspaces WHERE id=$1', [A.workspaceId])).rows[0].n);
  const ok = (r, code) => { if (r.status !== code) throw new Error(`setup ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
  const accounts = { PJ: ok(await a.request('POST', '/accounts', { name: 'Conta Corrente PJ - Banco Ação', accountType: 'PJ', expectedRevision: await rev() }), 201).account.id,
    PF: ok(await a.request('POST', '/accounts', { name: 'Cartão do Sócio PF', accountType: 'PF', expectedRevision: await rev() }), 201).account.id };
  const ids = [];
  for (const r of RECORDS) {
    const id = ok(await a.request('POST', '/transactions', { accountId: accounts[r.account], occurredOn: r.date, direction: r.direction, amountCents: r.cents, description: r.description,
      category: r.category, classification: r.classification, isPfBusinessExpense: Boolean(r.pf), explanation: '', expectedRevision: await rev() }), 201).transaction.transactionId;
    ids.push(id);
    if (r.doc) { const f = new FormData(); f.append('file', new Blob([Buffer.from(`%PDF-1.7\nSynthetic C05 ${r.doc}\n%%EOF\n`)], { type: 'application/pdf' }), r.doc); f.append('expectedRevision', String(await rev()));
      ok(await a.request('POST', `/transactions/${id}/documents`, f), 201); }
  }
  const outflow = ok(await a.request('POST', '/transactions', { accountId: accounts.PJ, occurredOn: '2026-11-05', direction: 'SAIDA', amountCents: 189900, description: 'Reembolso ao sócio (novembro)',
    category: 'TRANSFERÊNCIAS', classification: 'TRANSFERENCIA', isPfBusinessExpense: false, explanation: '', expectedRevision: await rev() }), 201).transaction.transactionId;
  ok(await a.request('POST', '/reimbursements', { pfExpenseTransactionId: ids[RECORDS.findIndex(r => r.reimburse)], pjReimbursementTransactionId: outflow, pfInflowTransactionId: null, notes: '', expectedRevision: await rev() }), 201);
  for (const [i, r] of RECORDS.entries()) if (r.justify) {
    const pending = (await admin.query(`SELECT id FROM mimir.pending_items WHERE transaction_id=$1 AND status='PENDENTE' ORDER BY type LIMIT 1`, [ids[i]])).rows[0].id;
    ok(await a.request('PATCH', `/pending-items/${pending}`, { action: 'JUSTIFY', justification: r.justify, expectedRevision: await rev() }), 200);
  }
  const op = ok(await a.request('POST', '/deliveries', { periodMonth: MONTH, expectedRevision: await rev(), rectificationReason: '' }, { 'Idempotency-Key': `c05-${Date.now()}-capture` }), 202);
  let ready = false; for (let i = 0; i < 150 && !ready; i++) { ready = (await a.request('GET', `/operations/${op.id}`)).json?.status === 'PRONTA'; if (!ready) await sleep(200); }
  if (!ready) throw new Error('entrega não ficou PRONTA');
  const zip = (await a.request('GET', `/deliveries/${op.snapshotId}/package`)).raw, manifest = (await a.request('GET', `/deliveries/${op.snapshotId}/manifest`)).raw;
  await writeFile('/out/entrega.zip', zip); await writeFile('/out/referencia.manifesto.json', manifest);
  for (const [name, data] of readZip(zip)) { await mkdir(dirname(join('/out/pacote', name)), { recursive: true }); await writeFile(join('/out/pacote', name), data); }
  const m = JSON.parse(manifest.toString('utf8')), docs = new Map(m.files.filter(f => f.documentId).map(f => [f.documentId, f.path]));
  const names = Object.fromEntries((await admin.query('SELECT id::text, original_name FROM mimir.documents WHERE workspace_id=$1', [A.workspaceId])).rows.map(r => [r.id, r.original_name]));
  const oracle = ids.map((id, n) => { const t = m.transactions.find(x => x.transactionId === id);
    return { n: n + 1, ref: `#${id.slice(0, 8)}`, transactionId: id, occurredOn: t.occurredOn, accountName: t.accountName, accountType: t.accountType, direction: t.direction, classification: t.classification,
      amountCents: t.amountCents, description: t.descriptionOriginal, category: t.categoryOriginal, documents: t.documentIds.map(d => names[d]), documentPaths: t.documentIds.map(d => docs.get(d)),
      reimbursementStatus: t.reimbursementStatus, pending: m.pendingItems.filter(p => p.transactionId === id).map(p => ({ type: p.pendingType, status: p.status, justification: p.justification })) }; });
  await writeFile('/out/referencia-c05.json', JSON.stringify({ source: 'manifesto da entrega (snapshot capturado)', snapshotId: op.snapshotId, manifestSha256: sha(manifest), records: oracle }, null, 2));
  await writeResult({ ...env, finishedAt: new Date().toISOString(), stage: 'pacote-gerado', snapshotId: op.snapshotId, manifestSha256: sha(manifest), zipSha256: sha(zip), records: oracle.length });
  console.log(`VERDICT PACOTE ${oracle.length} registros; manifesto ${sha(manifest).slice(0, 12)}`);
} catch (error) {
  console.log('ERROR ' + (error.stack ?? error)); process.exitCode = 2;
} finally { await api.stop(); await admin.end(); }
