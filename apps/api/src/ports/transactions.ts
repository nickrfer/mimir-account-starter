import type { WorkspaceActor } from './workspace.js';
export type Direction = 'ENTRADA' | 'SAIDA';
export type Classification = 'RECEITA' | 'DESPESA' | 'TRANSFERENCIA' | 'A_ESCLARECER';
export interface CreateTransaction {
  accountId: string; occurredOn: string; periodMonth: string; direction: Direction; amountCents: number;
  description: string; category: string; classification: Classification; isPfBusinessExpense: boolean;
  explanation: string; expectedRevision: number;
}
export interface ManualTransaction {
  transactionId: string; accountId: string; accountName: string; accountType: 'PF' | 'PJ'; occurredOn: string;
  direction: Direction; amountCents: number; descriptionOriginal: string; categoryOriginal: string;
  classification: Classification; isPfBusinessExpense: boolean; explanationOriginal: string;
  sourceType: 'MANUAL'; sourceCode: 'MANUAL'; externalId: string; documentIds: string[];
  reimbursementStatus: ReimbursementStatus;
}
export type ReimbursementStatus = 'NAO_APLICAVEL' | 'PENDENTE_REEMBOLSO' | 'REEMBOLSADA_NO_MES' | 'REEMBOLSADA_OUTRO_MES' | 'LIQUIDACAO_DE_REEMBOLSO';
export type PatchTransaction = Partial<Pick<CreateTransaction, 'accountId' | 'occurredOn' | 'direction' | 'amountCents' | 'description' | 'category' | 'classification' | 'isPfBusinessExpense' | 'explanation'>>;
export interface TransactionRecord extends Omit<ManualTransaction, 'reimbursementStatus' | 'sourceType' | 'sourceCode'> {
  sourceType: 'MANUAL' | 'CSV'; sourceCode: string; periodMonth: string; status: 'ATIVA' | 'EXCLUIDA'; reimbursementLinkId: string | null;
}
export interface TransactionMutation { transaction: TransactionRecord; revision: number }
export interface TransactionPage { cursor: { occurredOn: string; id: string } | null; limit: number }
export interface TransactionsPort {
  get(actor: WorkspaceActor, id: string): Promise<TransactionRecord>;
  list(actor: WorkspaceActor, month: string, page: TransactionPage): Promise<{items:TransactionRecord[];nextCursor:string|null;revision:number}>;
  update(actor: WorkspaceActor, id: string, changes: PatchTransaction, expectedRevision: number): Promise<TransactionMutation>;
  remove(actor: WorkspaceActor, id: string, expectedRevision: number): Promise<TransactionMutation>;
  create(actor: WorkspaceActor, command: CreateTransaction): Promise<{transaction:ManualTransaction;revision:number}>;
  close(): Promise<void>;
}
