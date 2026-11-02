import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) { console.error('uso: node tools/avaliacao/c05-conferencia.mjs <diretório out do C05>'); process.exit(2); }
const reference = JSON.parse(await readFile(join(out, 'referencia-c05.json'), 'utf8'));
const dom = await readFile(join(out, 'linux/chromium-dom.html'), 'utf8');
const loCsv = await readFile(join(out, 'linux/exportado/movimentacoes.csv'), 'utf8');

const LABEL = { ENTRADA: 'Entrada', SAIDA: 'Saída', RECEITA: 'Receita', DESPESA: 'Despesa', TRANSFERENCIA: 'Transferência', A_ESCLARECER: 'A esclarecer',
  PF: 'Pessoa física', PJ: 'Pessoa jurídica', NAO_APLICAVEL: '—', PENDENTE_REEMBOLSO: 'Reembolso pendente', REEMBOLSADA_NO_MES: 'Reembolsada no mês',
  REEMBOLSADA_OUTRO_MES: 'Reembolsada em outro mês', LIQUIDACAO_DE_REEMBOLSO: 'Liquidação de reembolso' };
const brl = cents => { const a = Math.abs(cents), r = String((a - a % 100) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); return `${cents < 0 ? '-' : ''}R$ ${r},${String(a % 100).padStart(2, '0')}`; };
const ddmmyyyy = iso => iso.split('-').reverse().join('/');
const unescape = s => s.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function csvRows(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c; continue; }
    if (c === '"') quoted = true; else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const section = dom.slice(dom.indexOf('Movimentações do mês'), dom.indexOf('Contexto de outros meses'));
const domRows = [...section.matchAll(/<tr>(.*?)<\/tr>/gs)].map(m => [...m[1].matchAll(/<td>(.*?)<\/td>/gs)].map(c => unescape(c[1]))).filter(r => r.length === 9);
const byRef = new Map(domRows.map(r => [r[8], r]));
const [header, ...loData] = csvRows(loCsv).filter(r => r.length > 1);
const col = name => header.indexOf(name);
const loById = new Map(loData.map(r => [r[col('transaction_id')], r]));
const guarded = v => /^[=+\-@\t\r\n]/.test(v) ? `'${v}` : v;

const records = reference.records.map(r => {
  const html = byRef.get(r.ref), lo = loById.get(r.transactionId);
  const expectedHtml = [ddmmyyyy(r.occurredOn), `${r.accountName} (${LABEL[r.accountType]})`, `${LABEL[r.direction]} · ${LABEL[r.classification]}`, brl(r.amountCents), r.description, r.category,
    LABEL[r.reimbursementStatus] ?? r.reimbursementStatus, r.documents.length ? r.documents.join(', ') : 'Sem documento', r.ref];
  const htmlChecks = ['data', 'conta', 'tipo', 'valor', 'descrição', 'categoria', 'reembolso', 'documentos', 'referência'].map((f, i) => ({ field: f, expected: expectedHtml[i], observed: html?.[i] ?? null, ok: html?.[i] === expectedHtml[i] }));
  const expectedLo = { occurred_on: r.occurredOn, account_name: guarded(r.accountName), account_type: r.accountType, direction: r.direction, amount_cents: String(r.amountCents),
    description: guarded(r.description), category: guarded(r.category), classification: r.classification };
  const loChecks = Object.entries(expectedLo).map(([f, e]) => ({ field: f, expected: e, observed: lo?.[col(f)] ?? null, ok: lo?.[col(f)] === e }));
  return { n: r.n, ref: r.ref, description: r.description, htmlOk: htmlChecks.every(c => c.ok), loOk: loChecks.every(c => c.ok), htmlChecks, loChecks };
});
const summary = { records: records.length, chromiumOk: records.filter(r => r.htmlOk).length, libreofficeOk: records.filter(r => r.loOk).length };
await writeFile(join(out, 'comparacao-c05.json'), JSON.stringify({ summary, records }, null, 2));
const img = async p => `data:image/png;base64,${(await readFile(join(out, p))).toString('base64')}`;
const cellRow = c => `<tr class="${c.ok ? 'ok' : 'bad'}"><td>${esc(c.field)}</td><td>${esc(c.expected)}</td><td>${esc(c.observed ?? '—')}</td><td>${c.ok ? 'igual' : 'DIFERENTE'}</td></tr>`;
const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Conferência C05</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:1200px;margin:24px auto;padding:0 16px;color:#1d2420}h1{font-size:22px}table{border-collapse:collapse;width:100%;margin:6px 0 18px}td,th{border:1px solid #cfd8d3;padding:4px 8px;text-align:left;vertical-align:top;white-space:pre-wrap}th{background:#eef3f0}.bad td{background:#fde8e6}.ok td:last-child{color:#1b7a3a}details{margin:6px 0}summary{cursor:pointer;font-weight:600}img{max-width:100%;border:1px solid #cfd8d3}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}</style>
<h1>Conferência C05 — 20 registros de referência</h1>
<p>Oráculo: manifesto da entrega <code>${esc(reference.snapshotId)}</code> (SHA-256 ${esc(reference.manifestSha256)}). Automático: Chromium Linux ${summary.chromiumOk}/20 iguais no HTML renderizado; LibreOffice Linux ${summary.libreofficeOk}/20 iguais no CSV interpretado. Firefox Windows: conferência visual pela captura abaixo.</p>
<p><b>Como conferir:</b> para cada registro, compare a linha do oráculo com a captura do Firefox (Windows) e do Chromium (Linux). Responda no chat com "C05 conferido: 20/20" ou indique os números com divergência.</p>
${records.map(r => `<details${r.htmlOk && r.loOk ? '' : ' open'}><summary>${r.n}. ${esc(r.ref)} — ${esc(r.description)} — Chromium: ${r.htmlOk ? 'ok' : 'DIVERGE'} · LibreOffice: ${r.loOk ? 'ok' : 'DIVERGE'}</summary>
<table><tr><th colspan="4">Resumo HTML (Chromium, Linux)</th></tr><tr><th>Campo</th><th>Esperado (oráculo)</th><th>Exibido</th><th></th></tr>${r.htmlChecks.map(cellRow).join('')}</table>
<table><tr><th colspan="4">CSV no LibreOffice (Linux, valores como exibidos)</th></tr><tr><th>Campo</th><th>Esperado</th><th>Exibido</th><th></th></tr>${r.loChecks.map(cellRow).join('')}</table></details>`).join('\n')}
<h2>Capturas</h2><div class="grid"><figure><figcaption>Firefox (Windows, offline)</figcaption><img src="${await img('windows/firefox-resumo.png')}"></figure>
<figure><figcaption>Chromium (Linux, sem rede)</figcaption><img src="${await img('linux/chromium-resumo.png')}"></figure></div></html>`;
await writeFile(join(out, 'conferencia-c05.html'), html);
console.log(JSON.stringify(summary));
