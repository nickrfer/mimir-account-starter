import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';

const pdf=Buffer.from('%PDF-1.7\nSynthetic I15\n%%EOF\n');
const id='3f2a9c1d-0000-4000-8000-000000000001',other='3f2a9c1d-0000-4000-8000-000000000002';
const code=expected=>error=>error.status===expected.status&&error.code===expected.code;

test('I15 reconciliação documental contra oráculo escrito à mão',async()=>{
  const {reconcileAutomaticPending}=await import('../../apps/api/dist/transactions/pending.js');
  const facts=(over={})=>({classification:'DESPESA',isPfBusinessExpense:false,hasDocuments:true,hasActiveReimbursement:false,...over});
  const p=(type,status,justification='')=>({type,status,justification});
  const cases=[
    ['vincular resolve documento ausente aberto',facts(),[p('DOCUMENTO_AUSENTE','PENDENTE')],[{type:'DOCUMENTO_AUSENTE',action:'RESOLVE'}]],
    ['vincular resolve documento ausente justificado',facts(),[p('DOCUMENTO_AUSENTE','JUSTIFICADA','sem nota')],[{type:'DOCUMENTO_AUSENTE',action:'RESOLVE'}]],
    ['vincular com ausente já resolvido não faz nada',facts(),[p('DOCUMENTO_AUSENTE','RESOLVIDA')],[]],
    ['desvincular último reabre resolvido',facts({hasDocuments:false}),[p('DOCUMENTO_AUSENTE','RESOLVIDA','antiga')],[{type:'DOCUMENTO_AUSENTE',action:'REOPEN'}]],
    ['desvincular último cria ausente inexistente',facts({hasDocuments:false}),[],[{type:'DOCUMENTO_AUSENTE',action:'INSERT'}]],
    ['desvincular último reabre justificado (mudança material)',facts({hasDocuments:false}),[p('DOCUMENTO_AUSENTE','JUSTIFICADA','x')],[{type:'DOCUMENTO_AUSENTE',action:'REOPEN'}]],
    ['desvincular último mantém aberto',facts({hasDocuments:false}),[p('DOCUMENTO_AUSENTE','PENDENTE')],[]],
    ['receita sem documento também reabre',facts({classification:'RECEITA',hasDocuments:false}),[p('DOCUMENTO_AUSENTE','RESOLVIDA')],[{type:'DOCUMENTO_AUSENTE',action:'REOPEN'}]],
    ['transferência sem documento não cria pendência',facts({classification:'TRANSFERENCIA',hasDocuments:false}),[],[]],
    ['a esclarecer justificada reabre por mudança material',facts({classification:'A_ESCLARECER',hasDocuments:false}),[p('CLASSIFICACAO_A_ESCLARECER','JUSTIFICADA','x')],[{type:'CLASSIFICACAO_A_ESCLARECER',action:'REOPEN'}]],
    ['reembolso PF justificado reabre por mudança material',facts({isPfBusinessExpense:true}),[p('DOCUMENTO_AUSENTE','RESOLVIDA'),p('REEMBOLSO_PF_PENDENTE','JUSTIFICADA','x')],[{type:'REEMBOLSO_PF_PENDENTE',action:'REOPEN'}]],
    ['dúvida manual nunca entra',facts({hasDocuments:false}),[p('DOCUMENTO_AUSENTE','PENDENTE'),p('DUVIDA_CADASTRADA','JUSTIFICADA','x')],[]],
  ];
  for(const [name,f,existing,expected] of cases)assert.deepEqual(reconcileAutomaticPending(f,existing,true),expected,name);
});

test('I15 entrada: ids, corpo de vínculo, revisão e consulta do mês',async()=>{
  const input=await import('../../apps/api/dist/documents/input.js');
  assert.equal(typeof input.documentIdInput,'function','I15 documentIdInput ausente');
  assert.equal(input.documentIdInput(id.toUpperCase()),id);
  for(const bad of ['', 'x', `${id}0`, '../etc'])assert.throws(()=>input.documentIdInput(bad),code({status:422,code:'INVALID_ID'}));
  assert.deepEqual(input.linkInput({documentId:id.toUpperCase(),expectedRevision:3}),{documentId:id,expectedRevision:3});
  for(const bad of [null,[],{documentId:id},{expectedRevision:3},{documentId:id,expectedRevision:0},{documentId:id,expectedRevision:'3'},
    {documentId:'x',expectedRevision:3},{documentId:id,expectedRevision:3,extra:1},{documentId:id,expectedRevision:1.5}])
    assert.throws(()=>input.linkInput(bad),code({status:422,code:'INVALID_INPUT'}),JSON.stringify(bad));
  assert.equal(input.revisionBodyInput({expectedRevision:7}),7);
  for(const bad of [{},{expectedRevision:7,x:1},{expectedRevision:-1},{expectedRevision:Number.MAX_SAFE_INTEGER+1}])
    assert.throws(()=>input.revisionBodyInput(bad),code({status:422,code:'INVALID_INPUT'}));
  assert.equal(input.documentListQuery(new URLSearchParams('periodMonth=2026-11')),'2026-11');
  for(const bad of ['','periodMonth=2026-11&periodMonth=2026-10','periodMonth=2026-11&limit=1','month=2026-11'])
    assert.throws(()=>input.documentListQuery(new URLSearchParams(bad)),code({status:400,code:'INVALID_QUERY'}),bad);
  assert.throws(()=>input.documentListQuery(new URLSearchParams('periodMonth=2026-13')),code({status:422,code:'INVALID_MONTH'}));
});

function multipartRequest(fields){
  const body=new FormData();for(const [k,v] of fields)body.append(k,...(Array.isArray(v)?v:[v]));
  const response=new Response(body);
  return response.arrayBuffer().then(bytes=>{const req=Readable.from([Buffer.from(bytes)]);req.headers={'content-type':response.headers.get('content-type'),'content-length':String(bytes.byteLength)};return req;});
}

test('I15 entrada da substituição: arquivo validado como no upload e documento substituído obrigatório',async()=>{
  const {replacementInput}=await import('../../apps/api/dist/documents/multipart.js');
  assert.equal(typeof replacementInput,'function','I15 replacementInput ausente');
  const file=[new Blob([pdf],{type:'application/pdf'}),'nota nova.pdf'];
  const ok=await replacementInput(await multipartRequest([['file',file],['replacedDocumentId',other.toUpperCase()],['expectedRevision','4']]));
  assert.equal(ok.replacedDocumentId,other);assert.equal(ok.document.expectedRevision,4);assert.equal(ok.document.originalName,'nota nova.pdf');
  assert.equal(ok.document.sizeBytes,pdf.length);assert.equal(ok.document.mime,'application/pdf');
  await assert.rejects(replacementInput(await multipartRequest([['file',file],['expectedRevision','4']])),code({status:422,code:'INVALID_INPUT'}));
  await assert.rejects(replacementInput(await multipartRequest([['file',file],['replacedDocumentId','x'],['expectedRevision','4']])),code({status:422,code:'INVALID_INPUT'}));
  await assert.rejects(replacementInput(await multipartRequest([['file',file],['replacedDocumentId',other],['expectedRevision','4'],['extra','1']])),code({status:422,code:'INVALID_INPUT'}));
  await assert.rejects(replacementInput(await multipartRequest([['file',[new Blob([pdf],{type:'application/pdf'}),'nota.exe']],['replacedDocumentId',other],['expectedRevision','4']])),
    code({status:415,code:'UNSUPPORTED_MEDIA_TYPE'}));
  await assert.rejects(replacementInput(await multipartRequest([['file',[new Blob([pdf],{type:'application/pdf'}),'nota.exe']],['replacedDocumentId','x'],['expectedRevision','4']])),
    code({status:415,code:'UNSUPPORTED_MEDIA_TYPE'}),'tipo do arquivo é avaliado antes do identificador');
  await assert.rejects(replacementInput(await multipartRequest([['file',[new Blob([Buffer.from('nao e pdf')],{type:'application/pdf'}),'n.pdf']],['replacedDocumentId',other],['expectedRevision','4']])),
    code({status:422,code:'INVALID_INPUT'}));
  const {multipartInput}=await import('../../apps/api/dist/documents/multipart.js');
  const upload=await multipartInput(await multipartRequest([['file',file],['expectedRevision','2']]));
  assert.equal(upload.expectedRevision,2,'upload do I05 continua aceitando só file e expectedRevision');
  await assert.rejects(multipartInput(await multipartRequest([['file',file],['replacedDocumentId',other],['expectedRevision','2']])),code({status:422,code:'INVALID_INPUT'}));
});
