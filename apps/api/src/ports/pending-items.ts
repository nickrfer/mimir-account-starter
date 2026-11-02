import type { WorkspaceActor } from './workspace.js';
export type PendingType = 'DOCUMENTO_AUSENTE' | 'CLASSIFICACAO_A_ESCLARECER' | 'REEMBOLSO_PF_PENDENTE' | 'DUVIDA_CADASTRADA';
export type PendingStatus = 'PENDENTE' | 'JUSTIFICADA' | 'RESOLVIDA';
export const pendingTypes: readonly PendingType[] = ['DOCUMENTO_AUSENTE', 'CLASSIFICACAO_A_ESCLARECER', 'REEMBOLSO_PF_PENDENTE', 'DUVIDA_CADASTRADA'];
export interface PendingItem {
  pendingId: string; transactionId: string; pendingType: PendingType; status: PendingStatus; description: string; justification: string;
}
export type PendingCommand =
  | { action: 'JUSTIFY'; justification: string }
  | { action: 'RESOLVE' }
  | { action: 'REOPEN' }
  | { action: 'EDIT'; description: string };
export interface PendingPage { cursor: { type: PendingType; id: string } | null; limit: number }
export interface PendingItemMutation { pendingItem: PendingItem; revision: number }
export interface PendingItemsPort {
  list(actor: WorkspaceActor, month: string, page: PendingPage): Promise<{ items: PendingItem[]; nextCursor: string | null; revision: number }>;
  registerQuestion(actor: WorkspaceActor, transactionId: string, description: string, expectedRevision: number): Promise<PendingItemMutation>;
  conduct(actor: WorkspaceActor, pendingId: string, command: PendingCommand, expectedRevision: number): Promise<PendingItemMutation>;
  close(): Promise<void>;
}
