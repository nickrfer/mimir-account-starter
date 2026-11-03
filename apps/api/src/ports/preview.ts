import type { WorkspaceActor } from './workspace.js';
import type { ManualTransaction } from './transactions.js';

export type PreviewTransaction = Omit<ManualTransaction, 'sourceType' | 'sourceCode'> & { sourceType: 'MANUAL' | 'CSV'; sourceCode: string };
export type RoleInPeriod = 'DESPESA_ORIGEM_NO_PERIODO' | 'REEMBOLSO_PJ_NO_PERIODO' | 'AMBOS_NO_PERIODO' | 'ENTRADA_PF_NO_PERIODO';
export interface ReimbursementLink {
  reimbursementLinkId: string; pfExpenseTransactionId: string; pjReimbursementTransactionId: string;
  pfInflowTransactionId: string | null; amountCents: number; pfOriginDocumentIds: string[]; roleInPeriod: RoleInPeriod;
}
export interface PreviewPending {
  pendingId: string; transactionId: string;
  pendingType: 'DOCUMENTO_AUSENTE' | 'CLASSIFICACAO_A_ESCLARECER' | 'REEMBOLSO_PF_PENDENTE' | 'DUVIDA_CADASTRADA';
  status: 'PENDENTE' | 'JUSTIFICADA' | 'RESOLVIDA'; description: string; justification: string;
}
export interface CategoryTotal { category: string; inflowCents: number; outflowCents: number; netCents: number }
export interface CashAccount {
  accountId: string; accountName: string; accountType: 'PF' | 'PJ'; inflowCents: number; outflowCents: number; netCents: number;
}
export interface PreviewSummary {
  cashFlowByAccount: CashAccount[]; businessRevenueTotalCents: number; businessExpenseTotalCents: number;
  reimbursementsSettledInPeriodCents: number; pendingCount: number; justifiedCount: number; categoryTotals: CategoryTotal[];
}
export interface Preview {
  workspace: { workspaceId: string; companyName: string; currency: 'BRL' }; periodMonth: string; revision: number;
  summary: PreviewSummary; transactions: PreviewTransaction[]; contextTransactions: PreviewTransaction[];
  reimbursementLinks: ReimbursementLink[]; pendingItems: PreviewPending[];
}
export interface PreviewPort {
  readPeriodPreview(actor: WorkspaceActor, month: string): Promise<Preview>;
  close(): Promise<void>;
}
