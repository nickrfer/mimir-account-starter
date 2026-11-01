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
