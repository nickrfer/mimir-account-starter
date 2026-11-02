import type { CapturedDocument, CapturedPayload } from '../ports/deliveries.js';
import { attachmentPath } from './csv.js';
import { formatBrl, formatBytes, formatCapturedAt, formatCivilDate, formatPeriodMonth, label, shortRef } from './format.js';
import { documentInclusionReasons } from './inclusion.js';

type Transaction = CapturedPayload['transactions'][number];

const STYLE = 'body{font-family:Arial,Helvetica,sans-serif;max-width:1200px;margin:24px auto;padding:0 16px;color:#1f2328;background:#fff;line-height:1.5}'
  + 'h1{font-size:24px;margin:0 0 8px}h2{font-size:18px;margin:32px 0 8px;padding-bottom:4px;border-bottom:2px solid #d0d7de}p{margin:8px 0}'
  + 'table{display:block;overflow-x:auto;max-width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 16px;font-variant-numeric:tabular-nums}'
  + 'th,td{border:1px solid #d0d7de;padding:6px 8px;text-align:left;vertical-align:top;overflow-wrap:break-word;min-width:64px}th{background:#eef2f6}a{color:#0b5cad}';

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const cell = (value: string | number) => `<td>${escapeHtml(String(value))}</td>`;
const row = (...cells: string[]) => `<tr>${cells.join('')}</tr>`;
const paragraph = (value: string) => `<p>${escapeHtml(value)}</p>`;
const table = <T>(headers: string[], rows: T[], render: (item: T) => string, emptyMessage: string) => rows.length
  ? `<table>${row(...headers.map(name => `<th>${escapeHtml(name)}</th>`))}${rows.map(render).join('')}</table>`
  : paragraph(emptyMessage);

export function renderSummaryHtml(payload: CapturedPayload): Buffer {
  const { workspace, delivery, summary } = payload;
  const documents = new Map(payload.documents.map(document => [document.documentId, document]));
  const transactions = new Map([...payload.transactions, ...payload.contextTransactions].map(t => [t.transactionId, t]));
  const inclusionReasons = documentInclusionReasons(payload);

  const describe = (transactionId: string) => {
    const t = transactions.get(transactionId);
    return t ? `${formatCivilDate(t.occurredOn)} · ${t.descriptionOriginal} · ${formatBrl(t.amountCents)}` : `Movimentação fora do pacote ${shortRef(transactionId)}`;
  };
  const documentLink = (document: CapturedDocument) => `<a href="${escapeHtml(attachmentPath(document))}">${escapeHtml(document.originalName)}</a>`;
  const documentLinks = (ids: string[]) => {
    const links = ids.flatMap(id => {
      const document = documents.get(id);
      return document ? [documentLink(document)] : [];
    });
    return `<td>${links.length ? links.join(', ') : 'Sem documento'}</td>`;
  };
  const transactionRow = (t: Transaction) => row(cell(formatCivilDate(t.occurredOn)), cell(`${t.accountName} (${label(t.accountType)})`),
    cell(`${label(t.direction)} · ${label(t.classification)}`), cell(formatBrl(t.amountCents)), cell(t.descriptionOriginal), cell(t.categoryOriginal),
    cell(label(t.reimbursementStatus)), documentLinks(t.documentIds), cell(shortRef(t.transactionId)));
  const transactionHeaders = ['Data', 'Conta', 'Tipo', 'Valor', 'Descrição', 'Categoria', 'Reembolso', 'Documentos', 'Ref.'];

  const period = formatPeriodMonth(delivery.periodMonth);
  const title = `Entrega de ${period} — versão ${delivery.versionNumber}`;
  const resolvedCount = payload.pendingItems.filter(p => p.status === 'RESOLVIDA').length;
  const overview: [string, string | number][] = [
    ['Empresa', workspace.companyName],
    ['Competência', period],
    ['Versão', delivery.versionNumber > 1 ? `${delivery.versionNumber} (retificação)` : delivery.versionNumber],
    ...(delivery.rectificationReason ? [['Motivo da retificação', delivery.rectificationReason] as [string, string]] : []),
    ['Capturada em', formatCapturedAt(delivery.capturedAt)],
    ['Revisão capturada', delivery.capturedRevision],
    ['Receita empresarial', formatBrl(summary.businessRevenueTotalCents)],
    ['Despesa empresarial', formatBrl(summary.businessExpenseTotalCents)],
    ['Reembolsos liquidados no mês', formatBrl(summary.reimbursementsSettledInPeriodCents)],
    ['Pendências abertas', summary.pendingCount],
    ['Pendências justificadas', summary.justifiedCount],
    ['Pendências resolvidas', resolvedCount],
  ];

  const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style>
<h1>${escapeHtml(title)}</h1>${paragraph('Resumo para conferência do contador. Este documento não é escrituração, documento fiscal nem revisão profissional.')}
<h2>Visão geral</h2><table>${overview.map(([name, value]) => row(`<th>${escapeHtml(name)}</th>`, cell(value))).join('')}</table>${paragraph('Justificativa é declaração do usuário; não resolve a pendência nem é validação fiscal.')}
<h2>Fluxo por conta</h2>${table(['Conta', 'Tipo', 'Entradas', 'Saídas', 'Saldo'], summary.cashFlowByAccount, a => row(cell(a.accountName), cell(label(a.accountType)),
    cell(formatBrl(a.inflowCents)), cell(formatBrl(a.outflowCents)), cell(formatBrl(a.netCents))), 'Nenhuma conta com movimentação no mês.')}
<h2>Totais por categoria</h2>${paragraph('Somente movimentações principais do mês. Transferências integram o fluxo. Registros de contexto não entram nos totais.')}${table(['Categoria', 'Entradas', 'Saídas', 'Saldo'],
    summary.categoryTotals, c => row(cell(c.category), cell(formatBrl(c.inflowCents)), cell(formatBrl(c.outflowCents)), cell(formatBrl(c.netCents))), 'Nenhuma categoria no mês.')}
<h2>Movimentações do mês</h2>${table(transactionHeaders, payload.transactions, transactionRow, 'Nenhuma movimentação no mês.')}
<h2>Contexto de outros meses</h2>${paragraph('Os registros abaixo não entram nos totais nem no CSV deste mês.')}${table(transactionHeaders, payload.contextTransactions, transactionRow, 'Nenhum registro de outro mês.')}
<h2>Vínculos de reembolso</h2>${paragraph('Despesa PF empresarial liquidada integralmente por transferência PJ. A liquidação não é somada como nova despesa.')}${table(
    ['Despesa PF', 'Saída PJ', 'Entrada PF', 'Valor', 'Papel no mês', 'Ref.'], payload.reimbursementLinks, l => row(cell(describe(l.pfExpenseTransactionId)),
      cell(describe(l.pjReimbursementTransactionId)), cell(l.pfInflowTransactionId ? describe(l.pfInflowTransactionId) : 'Não registrada'),
      cell(formatBrl(l.amountCents)), cell(label(l.roleInPeriod)), cell(shortRef(l.reimbursementLinkId))), 'Nenhum vínculo de reembolso.')}
<h2>Pendências</h2>${table(['Movimentação', 'Tipo', 'Status', 'Descrição', 'Justificativa', 'Ref.'], payload.pendingItems, p => row(cell(describe(p.transactionId)),
    cell(label(p.pendingType)), cell(label(p.status)), cell(p.description), cell(p.justification || '—'), cell(shortRef(p.pendingId))), 'Nenhuma pendência.')}
<h2>Documentos anexados</h2>${table(['Documento', 'Tipo', 'Tamanho', 'Motivo'], payload.documents, d => row(`<td>${documentLink(d)}</td>`,
    cell(label(d.mimeType)), cell(formatBytes(d.sizeBytes)), cell(inclusionReasons(d.documentId).map(label).join(', '))), 'Nenhum documento anexado.')}
${paragraph('A verificação de integridade exige cópia externa confiável do manifesto. Hashes não equivalem a assinatura digital. As referências iniciadas por # são o começo dos identificadores registrados no manifesto.json.')}</html>
`;
  return Buffer.from(html, 'utf8');
}
