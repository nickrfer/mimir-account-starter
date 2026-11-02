import {test} from 'node:test';
import assert from 'node:assert/strict';

const load=async()=>{const m=await import('../../apps/api/dist/domain/reimbursements.js').catch(()=>null);assert.ok(m,'I11 reimbursement domain missing');return m;};
const PF='11111111-1111-4111-8111-111111111111',PF2='22222222-2222-4222-8222-222222222222',PJ='33333333-3333-4333-8333-333333333333';
const expense=(extra={})=>({transactionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',accountId:PF,accountType:'PF',occurredOn:'2026-10-10',
  direction:'SAIDA',classification:'DESPESA',amountCents:10000,isPfBusinessExpense:true,...extra});
const outflow=(extra={})=>({transactionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',accountId:PJ,accountType:'PJ',occurredOn:'2026-11-05',
  direction:'SAIDA',classification:'TRANSFERENCIA',amountCents:10000,isPfBusinessExpense:false,...extra});
const inflow=(extra={})=>({transactionId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',accountId:PF,accountType:'PF',occurredOn:'2026-11-05',
  direction:'ENTRADA',classification:'TRANSFERENCIA',amountCents:10000,isPfBusinessExpense:false,...extra});

test('participant rules accept the documented full reimbursement, with or without PF inflow',async()=>{
  const {reimbursementViolation}=await load();
  assert.equal(reimbursementViolation(expense(),outflow(),null),null);
  assert.equal(reimbursementViolation(expense(),outflow(),inflow()),null);
  assert.equal(reimbursementViolation(expense({occurredOn:'2026-11-05'}),outflow(),inflow()),null,'same day is allowed');
});

test('participant rules reject each invalid role with a specific code',async()=>{
  const {reimbursementViolation:v}=await load();
  const cases=[
    [expense({isPfBusinessExpense:false}),outflow(),null,'REIMBURSEMENT_INVALID_PF_EXPENSE'],
    [expense({accountType:'PJ'}),outflow(),null,'REIMBURSEMENT_INVALID_PF_EXPENSE'],
    [expense({classification:'TRANSFERENCIA'}),outflow(),null,'REIMBURSEMENT_INVALID_PF_EXPENSE'],
    [expense(),outflow({accountType:'PF'}),null,'REIMBURSEMENT_INVALID_PJ_OUTFLOW'],
    [expense(),outflow({classification:'DESPESA'}),null,'REIMBURSEMENT_INVALID_PJ_OUTFLOW'],
    [expense(),outflow({direction:'ENTRADA'}),null,'REIMBURSEMENT_INVALID_PJ_OUTFLOW'],
    [expense(),outflow({amountCents:9999}),null,'REIMBURSEMENT_AMOUNT_MISMATCH'],
    [expense(),outflow({occurredOn:'2026-10-09'}),null,'REIMBURSEMENT_DATE_ORDER_INVALID'],
    [expense(),outflow(),inflow({accountId:PF2}),'REIMBURSEMENT_INVALID_PF_INFLOW'],
    [expense(),outflow(),inflow({classification:'RECEITA'}),'REIMBURSEMENT_INVALID_PF_INFLOW'],
    [expense(),outflow(),inflow({direction:'SAIDA'}),'REIMBURSEMENT_INVALID_PF_INFLOW'],
    [expense(),outflow(),inflow({amountCents:10001}),'REIMBURSEMENT_AMOUNT_MISMATCH'],
    [expense(),outflow(),inflow({occurredOn:'2026-11-04'}),'REIMBURSEMENT_DATE_ORDER_INVALID'],
  ];
  for(const [e,o,i,code] of cases)assert.equal(v(e,o,i),code,code);
});

test('role in period follows the manifest v2 rules for every participant month',async()=>{
  const {roleInPeriod}=await load();
  assert.equal(roleInPeriod('2026-10','2026-10-10','2026-10-20',null),'AMBOS_NO_PERIODO');
  assert.equal(roleInPeriod('2026-10','2026-10-10','2026-11-05','2026-11-05'),'DESPESA_ORIGEM_NO_PERIODO');
  assert.equal(roleInPeriod('2026-11','2026-10-10','2026-11-05','2026-11-05'),'REEMBOLSO_PJ_NO_PERIODO');
  assert.equal(roleInPeriod('2026-12','2026-10-10','2026-11-05','2026-12-01'),'ENTRADA_PF_NO_PERIODO');
  assert.equal(roleInPeriod('2027-01','2026-10-10','2026-11-05','2026-12-01'),null);
});

test('reimbursement status distinguishes same-month, other-month, settlement and pending',async()=>{
  const {reimbursementStatuses}=await load();
  const pending={transactionId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',occurredOn:'2026-10-01',isPfBusinessExpense:true};
  const plain={transactionId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',occurredOn:'2026-10-01',isPfBusinessExpense:false};
  const link={pfExpenseTransactionId:expense().transactionId,pjReimbursementTransactionId:outflow().transactionId,pfInflowTransactionId:inflow().transactionId};
  const all=[expense(),outflow(),inflow(),pending,plain];
  const statuses=reimbursementStatuses(all,[link]);
  assert.equal(statuses.get(expense().transactionId),'REEMBOLSADA_OUTRO_MES');
  assert.equal(statuses.get(outflow().transactionId),'LIQUIDACAO_DE_REEMBOLSO');
  assert.equal(statuses.get(inflow().transactionId),'LIQUIDACAO_DE_REEMBOLSO');
  assert.equal(statuses.get(pending.transactionId),'PENDENTE_REEMBOLSO');
  assert.equal(statuses.get(plain.transactionId),'NAO_APLICAVEL');
  const sameMonth=reimbursementStatuses([expense(),outflow({occurredOn:'2026-10-31'})],[{...link,pfInflowTransactionId:null}]);
  assert.equal(sameMonth.get(expense().transactionId),'REEMBOLSADA_NO_MES');
});

test('settled amount counts only links whose PJ outflow is a principal movement',async()=>{
  const {settledInPeriodCents}=await load();
  const links=[{pjReimbursementTransactionId:'a',amountCents:100},{pjReimbursementTransactionId:'b',amountCents:250},{pjReimbursementTransactionId:'c',amountCents:7}];
  assert.equal(settledInPeriodCents(new Set(['a','c','x']),links),107);
  assert.equal(settledInPeriodCents(new Set(),links),0);
});
