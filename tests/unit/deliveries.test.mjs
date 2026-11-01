import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const command={periodMonth:'2026-11',expectedRevision:1,rectificationReason:''};
const input=async()=>{const m=await import('../../apps/api/dist/deliveries/input.js').catch(()=>null);assert.ok(m,'I07 capture input missing');return m;};
const oracle=value=>createHash('sha256').update(Buffer.from(JSON.stringify([1,value.periodMonth,value.expectedRevision,value.rectificationReason]),'utf8')).digest('hex');

test('capture input accepts exact shape and canonicalizes Unicode, line endings and surrounding whitespace',async()=>{
  const m=await input();
  assert.deepEqual(m.captureInput(command),command);
  const normalized=m.captureInput({...command,rectificationReason:' \r\n Cafe\u0301\rnota \n '});
  assert.deepEqual(normalized,{...command,rectificationReason:'Café\nnota'});
  assert.equal(m.captureFingerprint(normalized),oracle(normalized));
  assert.equal(m.captureFingerprint(command),oracle(command));
  assert.notEqual(m.captureFingerprint({...command,rectificationReason:'x'}),oracle(command));
});

test('capture input rejects extra or missing fields, invalid month, revision and reason after normalization',async()=>{
  const m=await input();
  for(const value of [null,[],{}, {...command,other:1},{periodMonth:'2026-11',expectedRevision:1},
    {...command,periodMonth:'2026-00'},{...command,periodMonth:'1899-12'},{...command,periodMonth:'2026-1'},
    {...command,periodMonth:{}},{...command,expectedRevision:0},{...command,expectedRevision:1.5},
    {...command,expectedRevision:'1'},{...command,expectedRevision:Number.MAX_SAFE_INTEGER+1},
    {...command,rectificationReason:null},{...command,rectificationReason:1},
    {...command,rectificationReason:'x'.repeat(2001)},{...command,rectificationReason:'\u0344'.repeat(1001)}])
    assert.throws(()=>m.captureInput(value),error=>error.status===422);
  assert.equal(m.captureInput({...command,rectificationReason:'x'.repeat(2000)}).rectificationReason.length,2000);
});

test('idempotency key is strict ASCII token of 16 through 128 characters',async()=>{
  const m=await input();
  for(const value of ['A'.repeat(16),'a_-Z09'.repeat(20).slice(0,128)])assert.equal(m.idempotencyKey(value),value);
  for(const value of [null,{},'A'.repeat(15),'A'.repeat(129),' A'.repeat(16),'A'.repeat(16)+' ',
    'a'.repeat(15)+'é','a'.repeat(15)+'+','a'.repeat(15)+'\n','a'.repeat(16)+'\n'])assert.throws(()=>m.idempotencyKey(value));
});
