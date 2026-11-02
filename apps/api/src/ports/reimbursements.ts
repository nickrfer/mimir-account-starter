import type { WorkspaceActor } from './workspace.js';

export interface CreateReimbursement {
  pfExpenseTransactionId: string; pjReimbursementTransactionId: string; pfInflowTransactionId: string | null;
  notes: string; expectedRevision: number;
}
export interface ReimbursementRecord {
  reimbursementLinkId: string; pfExpenseTransactionId: string; pjReimbursementTransactionId: string; pfInflowTransactionId: string | null;
  amountCents: number; notes: string; status: 'ATIVO' | 'DESFEITO'; createdAt: string; undoneAt: string | null;
}
export interface ReimbursementMutation { reimbursement: ReimbursementRecord; revision: number }
export interface CandidateTransaction {
  transactionId: string; accountId: string; accountName: string; occurredOn: string; amountCents: number;
  descriptionOriginal: string; categoryOriginal: string;
}
export interface ReimbursementCandidates { pfExpense: CandidateTransaction; pjOutflows: CandidateTransaction[]; pfInflows: CandidateTransaction[] }
export interface ReimbursementPage { cursor: string | null; limit: number }
export interface ReimbursementsPort {
  create(actor: WorkspaceActor, command: CreateReimbursement): Promise<ReimbursementMutation>;
  undo(actor: WorkspaceActor, id: string, expectedRevision: number): Promise<ReimbursementMutation>;
  list(actor: WorkspaceActor, month: string, page: ReimbursementPage): Promise<{ items: ReimbursementRecord[]; nextCursor: string | null }>;
  candidates(actor: WorkspaceActor, pfExpenseId: string): Promise<ReimbursementCandidates>;
  close(): Promise<void>;
}
