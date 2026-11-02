import type pg from 'pg';
import { ApiError } from '../http/error.js';
import { summarizePeriod } from '../preview/summary.js';
import { reimbursementStatuses, roleInPeriod } from '../domain/reimbursements.js';
import type { WorkspaceActor } from '../ports/workspace.js';
import type { Preview, PreviewPending, PreviewTransaction, ReimbursementLink } from '../ports/preview.js';
import type { CapturedDocument, PeriodSelection } from '../ports/deliveries.js';

interface TransactionRow {
  id: string; account_id: string; name: string; account_type: 'PF' | 'PJ'; occurred_on: string;
  direction: PreviewTransaction['direction']; amount_cents: number; description: string; category: string;
  classification: PreviewTransaction['classification']; is_pf_business_expense: boolean; explanation: string;
  source_type: PreviewTransaction['sourceType']; source_code: string; external_id: string;
}
interface LinkRow { id: string; pf_expense_id: string; pj_outflow_id: string; pf_inflow_id: string | null; amount_cents: number }
function selectionLimit(): never { throw new ApiError(413, 'PREVIEW_LIMIT_EXCEEDED', 'Seleção excede os limites da prévia'); }
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const transactionColumns = `SELECT t.id,t.account_id,a.name,a.account_type,t.occurred_on,t.direction,t.amount_cents,
  t.description,t.category,t.classification,t.is_pf_business_expense,t.explanation,t.source_type,t.source_code,t.external_id
  FROM mimir.transactions t JOIN mimir.accounts a ON (a.workspace_id,a.id)=(t.workspace_id,t.account_id)`;

// The caller owns authorization, isolation and commit; this helper never opens a connection.
export async function selectPeriod(client: pg.PoolClient, actor: WorkspaceActor, month: string): Promise<PeriodSelection> {
  const workspace = (await client.query<{ id: string; company_name: string; currency: 'BRL'; revision: number }>(
    'SELECT id,company_name,currency,revision FROM mimir.workspaces WHERE id=$1 AND owner_id=$2', [actor.workspaceId, actor.userId])).rows[0];
  if (!workspace) throw new ApiError(404, 'NOT_FOUND', 'Objeto não encontrado');
  const selected = await client.query<TransactionRow>(`${transactionColumns}
    WHERE t.workspace_id=$1 AND t.period_month=$2 AND t.status='ATIVA' ORDER BY t.occurred_on,t.id LIMIT 1001`, [actor.workspaceId, month]);
  if (selected.rows.length > 1000) selectionLimit();
  const ids = selected.rows.map(row => row.id), principal = new Set(ids);
  const links = (await client.query<LinkRow>(`SELECT id,pf_expense_id,pj_outflow_id,pf_inflow_id,amount_cents FROM mimir.reimbursement_links
    WHERE workspace_id=$1 AND status='ATIVO' AND (pf_expense_id=ANY($2::uuid[]) OR pj_outflow_id=ANY($2::uuid[]) OR pf_inflow_id=ANY($2::uuid[]))
    ORDER BY id LIMIT 1001`, [actor.workspaceId, ids])).rows;
  if (links.length > 1000) selectionLimit();
  const contextIds = [...new Set(links.flatMap(link => [link.pf_expense_id, link.pj_outflow_id, link.pf_inflow_id])
    .filter((id): id is string => id !== null && !principal.has(id)))];
  if (ids.length + contextIds.length > 1000) selectionLimit();
  const context = contextIds.length ? (await client.query<TransactionRow>(`${transactionColumns}
    WHERE t.workspace_id=$1 AND t.id=ANY($2::uuid[]) AND t.status='ATIVA' ORDER BY t.occurred_on,t.id`, [actor.workspaceId, contextIds])).rows : [];
  if (context.length !== contextIds.length) throw new ApiError(500, 'INTERNAL_ERROR', 'Falha interna');
  const allIds = [...ids, ...contextIds];
  const documents = await client.query<{ transaction_id: string; document_id: string; size_bytes: number; original_name: string; mime: string; hash: string }>(`SELECT td.transaction_id,td.document_id,d.size_bytes,d.original_name,d.mime,d.hash
    FROM mimir.transaction_documents td JOIN mimir.documents d ON (d.workspace_id,d.id)=(td.workspace_id,td.document_id)
    WHERE td.workspace_id=$1 AND td.transaction_id=ANY($2::uuid[]) ORDER BY td.transaction_id,td.document_id LIMIT 10001`, [actor.workspaceId, allIds]);
  if (documents.rows.length > 10000) selectionLimit();
  const uniqueDocuments = new Map<string, CapturedDocument>(), byTransaction = new Map<string, string[]>();
  for (const row of documents.rows) {
    uniqueDocuments.set(row.document_id, { documentId: row.document_id, originalName: row.original_name, mimeType: row.mime, sizeBytes: row.size_bytes, sha256: row.hash });
    const list = byTransaction.get(row.transaction_id) ?? [];
    list.push(row.document_id); byTransaction.set(row.transaction_id, list);
    if (list.length > 1000) selectionLimit();
  }
  if (uniqueDocuments.size > 1000 || [...uniqueDocuments.values()].reduce((sum, document) => sum + document.sizeBytes, 0) > 100 * 1024 * 1024) selectionLimit();
  const pendingItems = (await client.query<PreviewPending>(`SELECT id AS "pendingId",transaction_id AS "transactionId",type AS "pendingType",status,description,justification
    FROM mimir.pending_items WHERE workspace_id=$1 AND transaction_id=ANY($2::uuid[]) ORDER BY type COLLATE "C",id LIMIT 4001`, [actor.workspaceId, ids])).rows;
  if (pendingItems.length > 4000) selectionLimit();

  const participants = links.map(link => ({ pfExpenseTransactionId: link.pf_expense_id, pjReimbursementTransactionId: link.pj_outflow_id, pfInflowTransactionId: link.pf_inflow_id }));
  const rows = [...selected.rows, ...context];
  const statuses = reimbursementStatuses(rows.map(row => ({ transactionId: row.id, occurredOn: row.occurred_on, isPfBusinessExpense: row.is_pf_business_expense })), participants);
  const toTransaction = (row: TransactionRow): PreviewTransaction => ({
    transactionId: row.id, accountId: row.account_id, accountName: row.name, accountType: row.account_type,
    occurredOn: row.occurred_on, direction: row.direction, amountCents: row.amount_cents, descriptionOriginal: row.description,
    categoryOriginal: row.category, classification: row.classification, isPfBusinessExpense: row.is_pf_business_expense,
    explanationOriginal: row.explanation, sourceType: row.source_type, sourceCode: row.source_code, externalId: row.external_id,
    documentIds: byTransaction.get(row.id) ?? [], reimbursementStatus: statuses.get(row.id)!
  });
  const transactions = selected.rows.map(toTransaction), contextTransactions = context.map(toTransaction);
  const dates = new Map(rows.map(row => [row.id, row.occurred_on]));
  const reimbursementLinks: ReimbursementLink[] = links.map(link => {
    const role = roleInPeriod(month, dates.get(link.pf_expense_id)!, dates.get(link.pj_outflow_id)!, link.pf_inflow_id ? dates.get(link.pf_inflow_id)! : null);
    if (!role) throw new ApiError(500, 'INTERNAL_ERROR', 'Falha interna');
    return { reimbursementLinkId: link.id, pfExpenseTransactionId: link.pf_expense_id, pjReimbursementTransactionId: link.pj_outflow_id,
      pfInflowTransactionId: link.pf_inflow_id, amountCents: link.amount_cents, pfOriginDocumentIds: byTransaction.get(link.pf_expense_id) ?? [], roleInPeriod: role };
  });
  const result: Preview = { workspace: { workspaceId: workspace.id, companyName: workspace.company_name, currency: workspace.currency },
    periodMonth: month, revision: workspace.revision, summary: summarizePeriod(transactions, pendingItems, reimbursementLinks), transactions,
    contextTransactions, reimbursementLinks, pendingItems };

  const period = (await client.query<{ notes: string }>('SELECT notes FROM mimir.periods WHERE workspace_id=$1 AND period_month=$2', [actor.workspaceId, month])).rows[0];
  return { preview: result, documents: [...uniqueDocuments.values()].sort((a, b) => byBytes(a.documentId, b.documentId)), period: { periodMonth: month, notes: period?.notes ?? '' } };
}
