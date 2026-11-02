import type { Classification, Direction, ReimbursementStatus } from '../ports/transactions.js';
import type { RoleInPeriod } from '../ports/preview.js';

export interface ParticipantFacts {
  transactionId: string; accountId: string; accountType: 'PF' | 'PJ'; occurredOn: string; direction: Direction;
  classification: Classification; amountCents: number; isPfBusinessExpense: boolean;
}
export type ReimbursementViolation = 'REIMBURSEMENT_INVALID_PF_EXPENSE' | 'REIMBURSEMENT_INVALID_PJ_OUTFLOW' | 'REIMBURSEMENT_INVALID_PF_INFLOW'
  | 'REIMBURSEMENT_AMOUNT_MISMATCH' | 'REIMBURSEMENT_DATE_ORDER_INVALID';
interface LinkParticipants { pfExpenseTransactionId: string; pjReimbursementTransactionId: string; pfInflowTransactionId: string | null }

export function reimbursementViolation(expense: ParticipantFacts, outflow: ParticipantFacts, inflow: ParticipantFacts | null): ReimbursementViolation | null {
  if (expense.accountType !== 'PF' || expense.direction !== 'SAIDA' || expense.classification !== 'DESPESA' || !expense.isPfBusinessExpense) return 'REIMBURSEMENT_INVALID_PF_EXPENSE';
  if (outflow.accountType !== 'PJ' || outflow.direction !== 'SAIDA' || outflow.classification !== 'TRANSFERENCIA' || outflow.isPfBusinessExpense) return 'REIMBURSEMENT_INVALID_PJ_OUTFLOW';
  if (outflow.amountCents !== expense.amountCents) return 'REIMBURSEMENT_AMOUNT_MISMATCH';
  if (outflow.occurredOn < expense.occurredOn) return 'REIMBURSEMENT_DATE_ORDER_INVALID';
  if (!inflow) return null;
  if (inflow.accountId !== expense.accountId || inflow.accountType !== 'PF' || inflow.direction !== 'ENTRADA'
    || inflow.classification !== 'TRANSFERENCIA' || inflow.isPfBusinessExpense) return 'REIMBURSEMENT_INVALID_PF_INFLOW';
  if (inflow.amountCents !== expense.amountCents) return 'REIMBURSEMENT_AMOUNT_MISMATCH';
  if (inflow.occurredOn < outflow.occurredOn) return 'REIMBURSEMENT_DATE_ORDER_INVALID';
  return null;
}

export function roleInPeriod(month: string, expenseOn: string, outflowOn: string, inflowOn: string | null): RoleInPeriod | null {
  const expenseHere = expenseOn.startsWith(`${month}-`), outflowHere = outflowOn.startsWith(`${month}-`);
  if (expenseHere && outflowHere) return 'AMBOS_NO_PERIODO';
  if (expenseHere) return 'DESPESA_ORIGEM_NO_PERIODO';
  if (outflowHere) return 'REEMBOLSO_PJ_NO_PERIODO';
  return inflowOn?.startsWith(`${month}-`) ? 'ENTRADA_PF_NO_PERIODO' : null;
}

export function reimbursementStatuses(transactions: readonly { transactionId: string; occurredOn: string; isPfBusinessExpense: boolean }[],
  links: readonly LinkParticipants[]): Map<string, ReimbursementStatus> {
  const dates = new Map(transactions.map(t => [t.transactionId, t.occurredOn]));
  const linked = new Map<string, ReimbursementStatus>();
  for (const link of links) {
    const expenseOn = dates.get(link.pfExpenseTransactionId), outflowOn = dates.get(link.pjReimbursementTransactionId);
    if (expenseOn && outflowOn) linked.set(link.pfExpenseTransactionId, expenseOn.slice(0, 7) === outflowOn.slice(0, 7) ? 'REEMBOLSADA_NO_MES' : 'REEMBOLSADA_OUTRO_MES');
    linked.set(link.pjReimbursementTransactionId, 'LIQUIDACAO_DE_REEMBOLSO');
    if (link.pfInflowTransactionId) linked.set(link.pfInflowTransactionId, 'LIQUIDACAO_DE_REEMBOLSO');
  }
  return new Map(transactions.map(t => [t.transactionId, linked.get(t.transactionId) ?? (t.isPfBusinessExpense ? 'PENDENTE_REEMBOLSO' : 'NAO_APLICAVEL')]));
}

export function settledInPeriodCents(principalIds: ReadonlySet<string>, links: readonly { pjReimbursementTransactionId: string; amountCents: number }[]): number {
  return links.reduce((sum, link) => principalIds.has(link.pjReimbursementTransactionId) ? sum + link.amountCents : sum, 0);
}
