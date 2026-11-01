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
  reimbursementStatus: 'NAO_APLICAVEL' | 'PENDENTE_REEMBOLSO';
}
export interface TransactionsPort {
  create(actor: WorkspaceActor, command: CreateTransaction): Promise<{transaction:ManualTransaction;revision:number}>;
  close(): Promise<void>;
}
