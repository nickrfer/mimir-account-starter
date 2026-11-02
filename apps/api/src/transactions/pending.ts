import type { Classification } from '../ports/transactions.js';
export type InitialPendingType = 'DOCUMENTO_AUSENTE' | 'CLASSIFICACAO_A_ESCLARECER' | 'REEMBOLSO_PF_PENDENTE';
export const pendingDescriptions: Record<InitialPendingType,string> = {
  DOCUMENTO_AUSENTE:'Comprovante ausente para receita ou despesa.',
  CLASSIFICACAO_A_ESCLARECER:'Classificação do registro precisa ser esclarecida.',
  REEMBOLSO_PF_PENDENTE:'Despesa empresarial PF sem vínculo de reembolso.'
};
// Creation has no documents or reimbursement links. Later mutations reconcile existing rows with their current facts.
export function initialPendingTypes(transaction: {classification:Classification;isPfBusinessExpense:boolean}): InitialPendingType[] {
  const types: InitialPendingType[]=[];
  if(['RECEITA','DESPESA'].includes(transaction.classification))types.push('DOCUMENTO_AUSENTE');
  if(transaction.classification==='A_ESCLARECER')types.push('CLASSIFICACAO_A_ESCLARECER');
  if(transaction.isPfBusinessExpense)types.push('REEMBOLSO_PF_PENDENTE');
  return types;
}
export type AutomaticPendingType = InitialPendingType;
export interface PendingFacts { classification: Classification; isPfBusinessExpense: boolean; hasDocuments: boolean; hasActiveReimbursement: boolean }
export interface ExistingPending { type: string; status: 'PENDENTE' | 'JUSTIFICADA' | 'RESOLVIDA'; justification: string }
export interface PendingAction { type: AutomaticPendingType; action: 'INSERT' | 'RESOLVE' | 'REOPEN' }

const automaticTypes: readonly AutomaticPendingType[] = ['DOCUMENTO_AUSENTE', 'CLASSIFICACAO_A_ESCLARECER', 'REEMBOLSO_PF_PENDENTE'];
function causePresent(type: AutomaticPendingType, facts: PendingFacts): boolean {
  if (type === 'DOCUMENTO_AUSENTE') return ['RECEITA', 'DESPESA'].includes(facts.classification) && !facts.hasDocuments;
  if (type === 'CLASSIFICACAO_A_ESCLARECER') return facts.classification === 'A_ESCLARECER';
  return facts.isPfBusinessExpense && !facts.hasActiveReimbursement;
}
export function reconcileAutomaticPending(facts: PendingFacts, existing: readonly ExistingPending[], materialChange: boolean): PendingAction[] {
  const actions: PendingAction[] = [];
  for (const type of automaticTypes) {
    const current = existing.find(item => item.type === type), present = causePresent(type, facts);
    if (!present) { if (current && current.status !== 'RESOLVIDA') actions.push({ type, action: 'RESOLVE' }); continue; }
    if (!current) actions.push({ type, action: 'INSERT' });
    else if (current.status === 'RESOLVIDA' || (current.status === 'JUSTIFICADA' && materialChange)) actions.push({ type, action: 'REOPEN' });
  }
  return actions;
}
