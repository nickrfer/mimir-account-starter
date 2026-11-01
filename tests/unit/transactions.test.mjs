import { test } from 'node:test';
import assert from 'node:assert/strict';
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const base={accountId:id,occurredOn:'2024-02-29',direction:'SAIDA',amountCents:1,description:' Cafe\u0301\r\nnota ',category:' Geral ',classification:'DESPESA',isPfBusinessExpense:false,explanation:'',expectedRevision:1};

test('manual transaction validates exact cents civil date normalized text and server-derived month',async()=>{
  const m=await import('../../apps/api/dist/transactions/input.js').catch(()=>null);assert.ok(m,'I04 command missing');
  const result=m.transactionInput(base);
  assert.equal(result.periodMonth,'2024-02');assert.equal(result.occurredOn,'2024-02-29');assert.equal(result.description,'Café\nnota');assert.equal(result.category,'Geral');
  for(const date of ['1900-01-01','2000-02-29','9999-12-31'])assert.equal(m.transactionInput({...base,occurredOn:date}).occurredOn,date);
  for(const extra of [{amountCents:0},{amountCents:-1},{amountCents:1.1},{amountCents:'1'},{amountCents:100000000000},{amountCents:9007199254740992},
    {occurredOn:'1900-02-29'},{occurredOn:'2023-02-29'},{occurredOn:'2024-02-30'},{occurredOn:'2024-01-01T00:00:00Z'},{occurredOn:'1899-12-31'},
    {accountId:'bad'},{direction:{toString:null}},{classification:'BAD'},{isPfBusinessExpense:'false'},{description:' '},{description:'\u0344'.repeat(300)},
    {category:'x'.repeat(101)},{explanation:'x'.repeat(2001)},{expectedRevision:0},{periodMonth:'2024-02'},{sourceType:'CSV'},{workspaceId:id}])
    assert.throws(()=>m.transactionInput({...base,...extra}),error=>error.status===422);
  assert.equal(m.transactionInput({...base,amountCents:99999999999}).amountCents,99999999999);
});
test('classification and PF business flag enforce account-sensitive rules without excluding PF receipts',async()=>{
  const m=await import('../../apps/api/dist/transactions/input.js').catch(()=>null);assert.ok(m,'I04 rules missing');
  for(const extra of [{classification:'RECEITA',direction:'SAIDA'},{classification:'DESPESA',direction:'ENTRADA'},
    {classification:'TRANSFERENCIA',isPfBusinessExpense:true},{classification:'A_ESCLARECER',isPfBusinessExpense:true}])
    assert.throws(()=>m.transactionInput({...base,...extra}),error=>error.status===422);
  const business=m.transactionInput({...base,isPfBusinessExpense:true});
  m.validateAccount(business,{accountType:'PF',active:true});
  assert.throws(()=>m.validateAccount(business,{accountType:'PJ',active:true}),error=>error.status===422);
  assert.throws(()=>m.validateAccount(business,{accountType:'PF',active:false}),error=>error.status===409);
  m.validateAccount(m.transactionInput({...base,classification:'RECEITA',direction:'ENTRADA'}),{accountType:'PF',active:true});
  for(const classification of ['TRANSFERENCIA','A_ESCLARECER'])for(const direction of ['ENTRADA','SAIDA'])m.transactionInput({...base,classification,direction});
});
test('initial pending predicates reflect document classification and PF-business conditions',async()=>{
  const m=await import('../../apps/api/dist/transactions/pending.js').catch(()=>null);assert.ok(m,'I04 pending predicates missing');
  assert.deepEqual(m.initialPendingTypes({classification:'RECEITA',isPfBusinessExpense:false}),['DOCUMENTO_AUSENTE']);
  assert.deepEqual(m.initialPendingTypes({classification:'DESPESA',isPfBusinessExpense:true}),['DOCUMENTO_AUSENTE','REEMBOLSO_PF_PENDENTE']);
  assert.deepEqual(m.initialPendingTypes({classification:'A_ESCLARECER',isPfBusinessExpense:false}),['CLASSIFICACAO_A_ESCLARECER']);
  assert.deepEqual(m.initialPendingTypes({classification:'TRANSFERENCIA',isPfBusinessExpense:false}),[]);
});
