import {test} from 'node:test';
import assert from 'node:assert/strict';

const a='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const transaction=(extra={})=>({transactionId:a,accountId:a,accountName:'PF',accountType:'PF',occurredOn:'2026-11-01',
  direction:'SAIDA',amountCents:100,descriptionOriginal:'Teste',categoryOriginal:'Ética',classification:'DESPESA',
  isPfBusinessExpense:false,explanationOriginal:'',sourceType:'MANUAL',sourceCode:'MANUAL',externalId:a,
  documentIds:[],reimbursementStatus:'NAO_APLICAVEL',...extra});

test('preview summary totals main movements by account/category and keeps PF income outside business revenue',async()=>{
  const m=await import('../../apps/api/dist/preview/summary.js').catch(()=>null);assert.ok(m,'I06 summary missing');
  const rows=[transaction({transactionId:a,amountCents:100,categoryOriginal:'Ética'}),
    transaction({transactionId:b,direction:'ENTRADA',classification:'RECEITA',amountCents:120,categoryOriginal:'Ética'}),
    transaction({transactionId:'cccccccc-cccc-cccc-cccc-cccccccccccc',accountId:b,accountName:'PJ',accountType:'PJ',
      direction:'ENTRADA',classification:'RECEITA',amountCents:500,categoryOriginal:'Água'}),
    transaction({transactionId:'dddddddd-dddd-dddd-dddd-dddddddddddd',accountId:b,accountName:'PJ',accountType:'PJ',
      direction:'SAIDA',classification:'TRANSFERENCIA',amountCents:50,categoryOriginal:'z'}),
    transaction({transactionId:'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',accountId:b,accountName:'PJ',accountType:'PJ',
      direction:'SAIDA',classification:'DESPESA',amountCents:70,categoryOriginal:'Água'}),
    transaction({transactionId:'ffffffff-ffff-ffff-ffff-ffffffffffff',isPfBusinessExpense:true,amountCents:30,categoryOriginal:'a'})];
  const pendings=[{status:'PENDENTE'},{status:'JUSTIFICADA'},{status:'RESOLVIDA'}];
  const s=m.summarizePeriod(rows,pendings);
  assert.deepEqual(Object.keys(s).sort(),['businessExpenseTotalCents','businessRevenueTotalCents','cashFlowByAccount','categoryTotals','justifiedCount','pendingCount','reimbursementsSettledInPeriodCents'].sort());
  assert.equal(s.businessRevenueTotalCents,500);assert.equal(s.businessExpenseTotalCents,100);
  assert.equal(s.reimbursementsSettledInPeriodCents,0);assert.equal(s.pendingCount,1);assert.equal(s.justifiedCount,1);
  assert.deepEqual(s.cashFlowByAccount,[
    {accountId:a,accountName:'PF',accountType:'PF',inflowCents:120,outflowCents:130,netCents:-10},
    {accountId:b,accountName:'PJ',accountType:'PJ',inflowCents:500,outflowCents:120,netCents:380}]);
  assert.deepEqual(s.categoryTotals,[
    {category:'a',inflowCents:0,outflowCents:30,netCents:-30},
    {category:'z',inflowCents:0,outflowCents:50,netCents:-50},
    {category:'Água',inflowCents:500,outflowCents:70,netCents:430},
    {category:'Ética',inflowCents:120,outflowCents:100,netCents:20}]);
});

test('preview summary empty month has exact zero aggregates and no phantom categories',async()=>{
  const m=await import('../../apps/api/dist/preview/summary.js').catch(()=>null);assert.ok(m,'I06 summary missing');
  assert.deepEqual(m.summarizePeriod([],[]),{cashFlowByAccount:[],businessRevenueTotalCents:0,businessExpenseTotalCents:0,
    reimbursementsSettledInPeriodCents:0,pendingCount:0,justifiedCount:0,categoryTotals:[]});
});

test('category totals keep zero net and case distinction, unsettled directions and safe 1000-row cents',async()=>{
  const m=await import('../../apps/api/dist/preview/summary.js').catch(()=>null);assert.ok(m,'I06 summary missing');
  const amount=99999999999,rows=Array.from({length:1000},(_,i)=>transaction({transactionId:`${String(i).padStart(8,'0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
    direction:i===0?'ENTRADA':'SAIDA',classification:'A_ESCLARECER',amountCents:i<2?100:amount,
    categoryOriginal:i<2?'Caso':i===2?'caso':'Volume'}));
  const before=structuredClone(rows),s=m.summarizePeriod(rows,[]);
  assert.deepEqual(rows,before);
  assert.deepEqual(s.categoryTotals,[
    {category:'Caso',inflowCents:100,outflowCents:100,netCents:0},
    {category:'Volume',inflowCents:0,outflowCents:997*amount,netCents:-(997*amount)},
    {category:'caso',inflowCents:0,outflowCents:amount,netCents:-amount}]);
  assert.equal(s.cashFlowByAccount[0].outflowCents,100+998*amount);
  assert.equal(s.businessRevenueTotalCents,0);assert.equal(s.businessExpenseTotalCents,0);
});
