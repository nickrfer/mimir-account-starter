import type { CashAccount, CategoryTotal, PreviewPending, PreviewSummary, PreviewTransaction, ReimbursementLink } from '../ports/preview.js';
import { settledInPeriodCents } from '../domain/reimbursements.js';

// Only the month's principal selection is accepted here; context never feeds totals.
export function summarizePeriod(transactions: readonly PreviewTransaction[], pendingItems: readonly PreviewPending[],
  links: readonly Pick<ReimbursementLink, 'pjReimbursementTransactionId' | 'amountCents'>[] = []): PreviewSummary {
  const accounts = new Map<string, CashAccount>(), categories = new Map<string, CategoryTotal>();
  let businessRevenueTotalCents = 0, businessExpenseTotalCents = 0;
  for (const transaction of transactions) {
    let account = accounts.get(transaction.accountId);
    if (!account) {
      account = { accountId: transaction.accountId, accountName: transaction.accountName, accountType: transaction.accountType, inflowCents: 0, outflowCents: 0, netCents: 0 };
      accounts.set(transaction.accountId, account);
    }
    let category = categories.get(transaction.categoryOriginal);
    if (!category) {
      category = { category: transaction.categoryOriginal, inflowCents: 0, outflowCents: 0, netCents: 0 };
      categories.set(transaction.categoryOriginal, category);
    }
    const field = transaction.direction === 'ENTRADA' ? 'inflowCents' : 'outflowCents';
    account[field] += transaction.amountCents; category[field] += transaction.amountCents;
    account.netCents = account.inflowCents - account.outflowCents;
    category.netCents = category.inflowCents - category.outflowCents;
    if (transaction.direction === 'ENTRADA' && transaction.classification === 'RECEITA' && transaction.accountType === 'PJ') businessRevenueTotalCents += transaction.amountCents;
    if (transaction.direction === 'SAIDA' && transaction.classification === 'DESPESA' && (transaction.accountType === 'PJ' || transaction.isPfBusinessExpense)) businessExpenseTotalCents += transaction.amountCents;
  }
  return {
    cashFlowByAccount: [...accounts.values()].sort((a,b) => Buffer.compare(Buffer.from(a.accountId), Buffer.from(b.accountId))),
    businessRevenueTotalCents, businessExpenseTotalCents, reimbursementsSettledInPeriodCents: settledInPeriodCents(new Set(transactions.map(t => t.transactionId)), links),
    pendingCount: pendingItems.filter(item => item.status === 'PENDENTE').length,
    justifiedCount: pendingItems.filter(item => item.status === 'JUSTIFICADA').length,
    categoryTotals: [...categories.values()].sort((a,b) => Buffer.compare(Buffer.from(a.category), Buffer.from(b.category)))
  };
}
