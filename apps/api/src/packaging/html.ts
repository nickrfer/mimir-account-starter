import type { CapturedPayload } from '../ports/deliveries.js';
import { attachmentPath } from './csv.js';

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const cell = (value: string | number | boolean) => `<td>${escapeHtml(String(value))}</td>`;
const head = (...names: string[]) => `<tr>${names.map(name => `<th>${name}</th>`).join('')}</tr>`;

export function renderSummaryHtml(payload: CapturedPayload): Buffer {
  const { workspace, delivery, summary } = payload;
  const documents = new Map(payload.documents.map(document => [document.documentId, document]));
  const links = (ids: string[]) => ids.map(id => {
    const document = documents.get(id);
    return document ? `<a href="${escapeHtml(attachmentPath(document))}">${escapeHtml(document.originalName)}</a>` : '';
  }).join(' ');
  const transactionTable = (rows: CapturedPayload['transactions']) => `<table>${head('Data', 'Conta', 'Direcao', 'Centavos', 'Descricao', 'Categoria', 'Documentos')}${
    rows.map(t => `<tr>${cell(t.occurredOn)}${cell(t.accountName)}${cell(t.direction)}${cell(t.amountCents)}${cell(t.descriptionOriginal)}${cell(t.categoryOriginal)}<td>${links(t.documentIds)}</td></tr>`).join('')}</table>`;
  const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrega ${escapeHtml(delivery.periodMonth)} versao ${delivery.versionNumber}</title><style>body{font-family:Arial,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;color:#202020;line-height:1.5}table{border-collapse:collapse;width:100%;font-size:14px;margin:16px 0}th,td{border:1px solid #ccc;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#edf1f4}h1,h2{color:#111}</style>
<h1>Entrega ${escapeHtml(delivery.periodMonth)} versao ${delivery.versionNumber}</h1><p>${escapeHtml(workspace.companyName)}. Revisao ${delivery.capturedRevision}. Capturada em ${escapeHtml(delivery.capturedAt)}. Nao e escrituracao, documento fiscal ou revisao profissional.</p>${delivery.rectificationReason ? `<p>Motivo da retificacao: ${escapeHtml(delivery.rectificationReason)}</p>` : ''}
<h2>Totais</h2><table>${head('Indicador', 'Centavos')}<tr>${cell('Receita empresarial')}${cell(summary.businessRevenueTotalCents)}</tr><tr>${cell('Despesa empresarial')}${cell(summary.businessExpenseTotalCents)}</tr><tr>${cell('Reembolsos liquidados no periodo')}${cell(summary.reimbursementsSettledInPeriodCents)}</tr><tr>${cell('Pendencias')}${cell(summary.pendingCount)}</tr><tr>${cell('Pendencias justificadas')}${cell(summary.justifiedCount)}</tr></table>
<h2>Fluxo por conta</h2><table>${head('Conta', 'Tipo', 'Entradas', 'Saidas', 'Saldo')}${summary.cashFlowByAccount.map(a => `<tr>${cell(a.accountName)}${cell(a.accountType)}${cell(a.inflowCents)}${cell(a.outflowCents)}${cell(a.netCents)}</tr>`).join('')}</table>
<h2>Totais por categoria</h2><p>Somente movimentacoes principais do mes. Transferencias integram o fluxo. Registros de contexto nao entram nos totais.</p><table>${head('Categoria', 'Entradas', 'Saidas', 'Saldo')}${summary.categoryTotals.map(c => `<tr>${cell(c.category)}${cell(c.inflowCents)}${cell(c.outflowCents)}${cell(c.netCents)}</tr>`).join('')}</table>
<h2>Movimentacoes do mes</h2>${transactionTable(payload.transactions)}
<h2>Contexto de outros meses</h2><p>Os registros abaixo nao entram nos totais nem no CSV deste mes.</p>${transactionTable(payload.contextTransactions)}
<h2>Vinculos de reembolso</h2><p>Despesa PF empresarial liquidada integralmente por transferencia PJ. A liquidacao nao e somada como nova despesa.</p><table>${head('Vinculo', 'Despesa PF', 'Saida PJ', 'Entrada PF', 'Centavos', 'Papel no periodo')}${payload.reimbursementLinks.map(l => `<tr>${cell(l.reimbursementLinkId)}${cell(l.pfExpenseTransactionId)}${cell(l.pjReimbursementTransactionId)}${cell(l.pfInflowTransactionId ?? '')}${cell(l.amountCents)}${cell(l.roleInPeriod)}</tr>`).join('')}</table>
<h2>Pendencias</h2><table>${head('Tipo', 'Status', 'Movimentacao', 'Descricao', 'Justificativa')}${payload.pendingItems.map(p => `<tr>${cell(p.pendingType)}${cell(p.status)}${cell(p.transactionId)}${cell(p.description)}${cell(p.justification)}</tr>`).join('')}</table>
<p>Verificacao de integridade exige copia externa confiavel do manifesto. Hashes nao equivalem a assinatura digital.</p></html>
`;
  return Buffer.from(html, 'utf8');
}
