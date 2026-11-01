import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

test('administrative stdin preserves UTF-8 split across chunks and rejects invalid/large data',async()=>{
  const module=await import('../../tools/admin/read-input.mjs').catch(()=>null);
  assert.ok(module,'bounded UTF-8 administrative reader missing');
  const bytes=Buffer.from('{"password":"synthetic-💠-senha"}');
  const split=bytes.indexOf(Buffer.from('💠'))+1;
  const value=await module.readAdminInput(Readable.from([bytes.subarray(0,split),bytes.subarray(split)]));
  assert.equal(value.password,'synthetic-💠-senha');
  await assert.rejects(module.readAdminInput(Readable.from([Buffer.from([0xff])])));
  await assert.rejects(module.readAdminInput(Readable.from([Buffer.alloc(8193)])));
});
