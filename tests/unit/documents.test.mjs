import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {documentInput,revisionInput,MAX_DOCUMENT_BYTES} from '../../apps/api/dist/documents/input.js';
const pdf=Buffer.from('%PDF-1.7\nSynthetic\n%%EOF\n');
test('I05 document metadata and hash are derived from validated bytes',()=>{
  const command=documentInput('  cafe\u0301.PDF  ','application/pdf',pdf,2);
  assert.deepEqual(command,{originalName:'café.PDF',mime:'application/pdf',bytes:pdf,sizeBytes:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex'),expectedRevision:2});
  const png=Buffer.from('89504e470d0a1a0a','hex'),jpeg=Buffer.from('ffd8ffe0','hex');
  assert.equal(documentInput('a.png','image/png',png,1).mime,'image/png');
  for(const name of ['a.jpg','a.JPEG'])assert.equal(documentInput(name,'image/jpeg',jpeg,1).mime,'image/jpeg');
  const max=Buffer.alloc(MAX_DOCUMENT_BYTES);pdf.copy(max);assert.equal(documentInput('a.pdf','application/pdf',max,1).sizeBytes,5242880);
});
test('I05 extension MIME signature and size are independently enforced',()=>{
  const fails=(name,mime,bytes,status)=>assert.throws(()=>documentInput(name,mime,bytes,1),e=>e.status===status);
  fails('a.txt','application/pdf',pdf,415);fails('a.pdf','image/png',pdf,415);fails('a.pdf','application/octet-stream',pdf,415);
  fails('a.pdf','application/pdf',Buffer.from('Not PDF'),422);fails('a.png','image/png',pdf,422);fails('a.jpg','image/jpeg',pdf,422);
  fails('a.pdf','application/pdf',Buffer.alloc(0),422);fails('a.pdf','application/pdf',Buffer.alloc(MAX_DOCUMENT_BYTES+1),413);
});
test('I05 metadata is bounded and revision multipart text is a strict safe integer',()=>{
  for(const name of ['', ' '.repeat(3),'x'.repeat(252)+'.pdf','../a.pdf','C:\\a.pdf','a\0.pdf','a\r.pdf'])assert.throws(()=>documentInput(name,'application/pdf',pdf,1),e=>e.status===422);
  assert.equal(documentInput('😀'.repeat(251)+'.pdf','application/pdf',pdf,1).originalName.length,506);
  for(const value of ['0','-1','1.0','1e2',' 1','01','9007199254740992','',null])assert.throws(()=>revisionInput(value),e=>e.status===422);
  assert.equal(revisionInput('9007199254740991'),Number.MAX_SAFE_INTEGER);assert.equal(revisionInput('1'),1);
});
