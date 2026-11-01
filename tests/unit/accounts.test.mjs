import { test } from 'node:test';
import assert from 'node:assert/strict';

test('account command normalizes names and preserves a bounded public Unicode name',async()=>{
  const module=await import('../../apps/api/dist/accounts/input.js').catch(()=>null);
  assert.ok(module,'I03 account command missing');
  assert.deepEqual(module.accountInput({name:'  Cafe\u0301  ',accountType:'PF',expectedRevision:1}),
    {name:'Café',nameKey:'café',accountType:'PF',expectedRevision:1});
  assert.equal([...module.accountInput({name:'İ'.repeat(200),accountType:'PJ',expectedRevision:1}).nameKey].length,400);
  assert.equal([...module.accountInput({name:'\u0344'.repeat(100),accountType:'PF',expectedRevision:1}).name].length,200);
  for(const value of [{name:' ',accountType:'PF',expectedRevision:1},{name:'x',accountType:'XX',expectedRevision:1},
    {name:'x',accountType:'PF',expectedRevision:'1'},{name:'x',accountType:'PF',expectedRevision:0},
    {name:'x',accountType:'PF',expectedRevision:9007199254740992},{name:'x'.repeat(201),accountType:'PF',expectedRevision:1},
    {name:'x',accountType:'PF',expectedRevision:1,workspaceId:'foreign'},
    {name:'x',accountType:{toString:null},expectedRevision:1},
    {name:'\u0344'.repeat(200),accountType:'PF',expectedRevision:1}])assert.throws(()=>module.accountInput(value),error=>error.status===422);
});

test('account pagination rejects unknown, repeated or unbounded parameters',async()=>{
  const module=await import('../../apps/api/dist/accounts/input.js').catch(()=>null);
  assert.ok(module,'I03 account pagination missing');
  assert.deepEqual(module.accountPageInput(new URLSearchParams()),{limit:100,cursor:null});
  assert.deepEqual(module.accountPageInput(new URLSearchParams('limit=200&cursor=AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')),
    {limit:200,cursor:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'});
  for(const query of ['limit=0','limit=201','limit=1e2','limit=1.5','limit=1&limit=2','cursor=bad','cursor=','workspaceId=foreign'])
    assert.throws(()=>module.accountPageInput(new URLSearchParams(query)));
  assert.equal(module.nextRevision(2,2),3);
  assert.throws(()=>module.nextRevision(2,1),error=>error.status===409&&error.code==='REVISION_CONFLICT');
  assert.throws(()=>module.nextRevision(9007199254740991,9007199254740991),error=>error.status===409&&error.code==='REVISION_EXHAUSTED');
});
