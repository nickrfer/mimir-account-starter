import { exactObject, text } from '../auth/input.js';
import { civilDate } from '../domain/values.js';
import { ApiError } from '../http/error.js';
import type { Classification, CreateTransaction, Direction, PatchTransaction } from '../ports/transactions.js';
const invalid = () => new ApiError(422,'INVALID_INPUT','Dados inválidos');
export const normalized = (value: unknown,min: number,max: number): string => text(text(value,min,max).normalize('NFC').replace(/\r\n?/g,'\n').trim(),min,max);
function enumValue<T extends string>(value: unknown, choices: readonly T[]): T {
  if(typeof value!=='string'||!choices.includes(value as T))throw invalid();
  return value as T;
}
export function transactionInput(value: unknown): CreateTransaction {
  const input=exactObject(value,['accountId','occurredOn','direction','amountCents','description','category','classification','isPfBusinessExpense','explanation','expectedRevision']);
  const accountId=text(input.accountId,36,36).toLowerCase();
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(accountId))throw invalid();
  let occurredOn: string;
  try{occurredOn=civilDate(text(input.occurredOn,10,10));}catch{throw invalid();}
  const direction=enumValue<Direction>(input.direction,['ENTRADA','SAIDA']);
  const classification=enumValue<Classification>(input.classification,['RECEITA','DESPESA','TRANSFERENCIA','A_ESCLARECER']);
  if(typeof input.amountCents!=='number'||!Number.isSafeInteger(input.amountCents)||input.amountCents<1||input.amountCents>99999999999||
    typeof input.expectedRevision!=='number'||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||typeof input.isPfBusinessExpense!=='boolean')throw invalid();
  if((classification==='RECEITA'&&direction!=='ENTRADA')||(classification==='DESPESA'&&direction!=='SAIDA')||
    (input.isPfBusinessExpense&&(classification!=='DESPESA'||direction!=='SAIDA')))throw invalid();
  return{accountId,occurredOn,periodMonth:occurredOn.slice(0,7),direction,amountCents:input.amountCents,
    description:normalized(input.description,1,500),category:normalized(input.category,1,100),classification,
    isPfBusinessExpense:input.isPfBusinessExpense,explanation:normalized(input.explanation,0,2000),expectedRevision:input.expectedRevision};
}
export function validateAccount(command: CreateTransaction, account: {accountType:'PF'|'PJ';active:boolean}): void {
  if(!account.active)throw new ApiError(409,'ACCOUNT_INACTIVE','Conta inativa');
  if(command.isPfBusinessExpense&&account.accountType!=='PF')throw new ApiError(422,'INVALID_PF_BUSINESS_EXPENSE','Marca empresarial exige despesa em conta PF');
}
const patchFields=['accountId','occurredOn','direction','amountCents','description','category','classification','isPfBusinessExpense','explanation'] as const;
export function transactionPatchInput(value: unknown): {changes:PatchTransaction;expectedRevision:number} {
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
  const input=value as Record<string,unknown>,keys=Object.keys(input);
  if(!keys.includes('expectedRevision')||keys.length<2||keys.some(key=>key!=='expectedRevision'&&!(patchFields as readonly string[]).includes(key)))throw invalid();
  if(typeof input.expectedRevision!=='number'||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)throw invalid();
  const changes: PatchTransaction={};
  if('accountId' in input){const accountId=text(input.accountId,36,36).toLowerCase();if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(accountId))throw invalid();changes.accountId=accountId;}
  if('occurredOn' in input){try{changes.occurredOn=civilDate(text(input.occurredOn,10,10));}catch{throw invalid();}}
  if('direction' in input)changes.direction=enumValue<Direction>(input.direction,['ENTRADA','SAIDA']);
  if('amountCents' in input){if(typeof input.amountCents!=='number'||!Number.isSafeInteger(input.amountCents)||input.amountCents<1||input.amountCents>99999999999)throw invalid();changes.amountCents=input.amountCents;}
  if('description' in input)changes.description=normalized(input.description,1,500);
  if('category' in input)changes.category=normalized(input.category,1,100);
  if('classification' in input)changes.classification=enumValue<Classification>(input.classification,['RECEITA','DESPESA','TRANSFERENCIA','A_ESCLARECER']);
  if('isPfBusinessExpense' in input){if(typeof input.isPfBusinessExpense!=='boolean')throw invalid();changes.isPfBusinessExpense=input.isPfBusinessExpense;}
  if('explanation' in input)changes.explanation=normalized(input.explanation,0,2000);
  return{changes,expectedRevision:input.expectedRevision};
}
export function mergedRulesValid(merged: {direction:Direction;classification:Classification;isPfBusinessExpense:boolean}): void {
  if((merged.classification==='RECEITA'&&merged.direction!=='ENTRADA')||(merged.classification==='DESPESA'&&merged.direction!=='SAIDA')||
    (merged.isPfBusinessExpense&&(merged.classification!=='DESPESA'||merged.direction!=='SAIDA')))throw invalid();
}
