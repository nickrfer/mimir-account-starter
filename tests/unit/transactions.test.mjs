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

const loadPending=async()=>{const m=await import('../../apps/api/dist/transactions/pending.js');assert.ok(m.reconcileAutomaticPending,'I12 reconciliation missing');return m;};
const facts=(extra={})=>({classification:'DESPESA',isPfBusinessExpense:false,hasDocuments:false,hasActiveReimbursement:false,...extra});
const row=(type,status,justification='')=>({type,status,justification});
const byType=actions=>Object.fromEntries(actions.map(a=>[a.type,a.action]));

test('I12 reconciliation: lost cause resolves, new cause inserts, resolved cause reopens',async()=>{
  const {reconcileAutomaticPending:r}=await loadPending();
  assert.deepEqual(byType(r(facts({classification:'TRANSFERENCIA'}),[row('DOCUMENTO_AUSENTE','PENDENTE')],true)),{DOCUMENTO_AUSENTE:'RESOLVE'});
  assert.deepEqual(byType(r(facts(),[],true)),{DOCUMENTO_AUSENTE:'INSERT'});
  assert.deepEqual(byType(r(facts({classification:'A_ESCLARECER'}),[row('DOCUMENTO_AUSENTE','PENDENTE')],true)),{DOCUMENTO_AUSENTE:'RESOLVE',CLASSIFICACAO_A_ESCLARECER:'INSERT'});
  assert.deepEqual(byType(r(facts(),[row('DOCUMENTO_AUSENTE','RESOLVIDA','antiga')],false)),{DOCUMENTO_AUSENTE:'REOPEN'});
  assert.deepEqual(byType(r(facts({hasDocuments:true}),[row('DOCUMENTO_AUSENTE','RESOLVIDA')],true)),{});
  assert.deepEqual(byType(r(facts({classification:'TRANSFERENCIA'}),[row('DOCUMENTO_AUSENTE','RESOLVIDA')],true)),{});
});

test('I12 reconciliation: justified pending survives text-only change and reopens on material change',async()=>{
  const {reconcileAutomaticPending:r}=await loadPending();
  const justified=[row('DOCUMENTO_AUSENTE','JUSTIFICADA','Comprovante extraviado')];
  assert.deepEqual(byType(r(facts(),justified,false)),{});
  assert.deepEqual(byType(r(facts(),justified,true)),{DOCUMENTO_AUSENTE:'REOPEN'});
  assert.deepEqual(byType(r(facts({classification:'TRANSFERENCIA'}),justified,false)),{DOCUMENTO_AUSENTE:'RESOLVE'});
});

test('I12 reconciliation: PF reimbursement pending follows the business flag and active link; manual questions untouched',async()=>{
  const {reconcileAutomaticPending:r}=await loadPending();
  assert.deepEqual(byType(r(facts({isPfBusinessExpense:true,hasDocuments:true}),[],true)),{REEMBOLSO_PF_PENDENTE:'INSERT'});
  assert.deepEqual(byType(r(facts({isPfBusinessExpense:true,hasDocuments:true,hasActiveReimbursement:true}),[row('REEMBOLSO_PF_PENDENTE','RESOLVIDA')],false)),{});
  assert.deepEqual(byType(r(facts({hasDocuments:true}),[row('REEMBOLSO_PF_PENDENTE','PENDENTE')],true)),{REEMBOLSO_PF_PENDENTE:'RESOLVE'});
  assert.deepEqual(byType(r(facts({classification:'TRANSFERENCIA'}),[row('DUVIDA_CADASTRADA','PENDENTE')],true)),{});
});

test('I12 patch input accepts partial changes only and normalizes like creation',async()=>{
  const m=await import('../../apps/api/dist/transactions/input.js');assert.ok(m.transactionPatchInput,'I12 patch input missing');
  assert.deepEqual(m.transactionPatchInput({amountCents:120,expectedRevision:3}),{changes:{amountCents:120},expectedRevision:3});
  assert.deepEqual(m.transactionPatchInput({description:' Café ',accountId:id.toUpperCase(),expectedRevision:1}).changes,{description:'Café',accountId:id});
  for(const bad of [{expectedRevision:1},{amountCents:0,expectedRevision:1},{occurredOn:'2023-02-29',expectedRevision:1},{periodMonth:'2024-01',expectedRevision:1},
    {description:' ',expectedRevision:1},{direction:'X',expectedRevision:1},{amountCents:1},{isPfBusinessExpense:'true',expectedRevision:1},{explanation:'x'.repeat(2001),expectedRevision:1},null,[]])
    assert.throws(()=>m.transactionPatchInput(bad),error=>error.status===422,JSON.stringify(bad));
});
