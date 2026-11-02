import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {crc32,inflateRawSync} from 'node:zlib';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function readZip(bytes){
  const end=bytes.length-22;assert.equal(bytes.readUInt32LE(end),0x06054b50);
  const count=bytes.readUInt16LE(end+10);let at=bytes.readUInt32LE(end+16);const entries=new Map();
  for(let i=0;i<count;i++){
    assert.equal(bytes.readUInt32LE(at),0x02014b50);
    const method=bytes.readUInt16LE(at+10),crc=bytes.readUInt32LE(at+16),csize=bytes.readUInt32LE(at+20),size=bytes.readUInt32LE(at+24),nameLength=bytes.readUInt16LE(at+28),offset=bytes.readUInt32LE(at+42);
    const name=bytes.subarray(at+46,at+46+nameLength).toString('utf8');
    assert.equal(bytes.readUInt32LE(offset),0x04034b50);
    const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28),raw=bytes.subarray(start,start+csize);
    const data=method===8?inflateRawSync(raw):raw;assert.equal(data.length,size);assert.equal(crc32(data),crc);
    assert.ok(!entries.has(name));entries.set(name,data);at+=46+nameLength;
  }
  return entries;
}
const document=(bytes,name='comprovante.pdf',mime='application/pdf')=>({documentId:randomUUID(),originalName:name,mimeType:mime,sizeBytes:bytes.length,sha256:sha(bytes)});
function payload(documents,overrides={}){
  const tx={transactionId:randomUUID(),accountId:randomUUID(),accountName:'=Conta, "PF"',accountType:'PF',occurredOn:'2026-11-03',direction:'SAIDA',amountCents:1250,
    descriptionOriginal:'<b>Despesa</b> & cia',categoryOriginal:'+Geral',classification:'DESPESA',isPfBusinessExpense:true,explanationOriginal:'linha1\nlinha2',sourceType:'MANUAL',sourceCode:'MANUAL',
    externalId:'ext',documentIds:documents.map(d=>d.documentId),reimbursementStatus:'PENDENTE_REEMBOLSO',...overrides};
  return {schemaVersion:'mimir.snapshot.v1',workspace:{workspaceId:randomUUID(),companyName:'Empresa <Sintetica>',currency:'BRL'},
    delivery:{snapshotId:randomUUID(),operationId:randomUUID(),periodMonth:'2026-11',versionNumber:2,capturedRevision:7,rectificationReason:'Motivo <x>',capturedAt:'2026-11-05T12:00:00.000Z'},
    summary:{cashFlowByAccount:[{accountId:tx.accountId,accountName:tx.accountName,accountType:'PF',inflowCents:0,outflowCents:1250,netCents:-1250}],businessRevenueTotalCents:0,businessExpenseTotalCents:1250,
      reimbursementsSettledInPeriodCents:0,pendingCount:1,justifiedCount:0,categoryTotals:[{category:'+Geral',inflowCents:0,outflowCents:1250,netCents:-1250}]},
    transactions:[tx],contextTransactions:[],reimbursementLinks:[],pendingItems:[{pendingId:randomUUID(),transactionId:tx.transactionId,pendingType:'REEMBOLSO_PF_PENDENTE',status:'PENDENTE',description:'<script>x</script>',justification:''}],
    documents,period:{periodMonth:'2026-11',notes:''}};
}

test('I08 packaging: CSV neutralisation, escaped HTML, manifest and ZIP from the snapshot only',async()=>{
  const csv=await import('../../apps/api/dist/packaging/csv.js').catch(()=>null);assert.ok(csv,'I08 packaging missing');
  const {buildPackage,buildManifest}=await import('../../apps/api/dist/packaging/build.js');
  const {renderSummaryHtml}=await import('../../apps/api/dist/packaging/html.js');
  const bytes=Buffer.from('%PDF-1.7\nSynthetic I08\n%%EOF\n'),doc=document(bytes),p=payload([doc]);
  const sheet=csv.renderCsv(p).toString('utf8');
  assert.equal(sheet.split('\r\n').length,3);assert.match(sheet,/,"'=Conta, ""PF""",PF,/);assert.match(sheet,/,'\+Geral,/);assert.match(sheet,/,"linha1\nlinha2",/);assert.ok(sheet.endsWith('\r\n'));
  assert.ok(!sheet.includes(`'${p.transactions[0].transactionId}`));
  const html=renderSummaryHtml(p).toString('utf8');
  for(const raw of ['<b>','<script>','<Sintetica>','Motivo <x>'])assert.ok(!html.includes(raw),raw);
  assert.match(html,/&lt;script&gt;x&lt;\/script&gt;/);assert.match(html,new RegExp(`href="anexos/${doc.documentId}\\.pdf"`));assert.ok(!/<script|<form|https?:\/\//i.test(html));
  const dir=await mkdtemp(join(tmpdir(),'mimir-i08-'));
  try{
    const built=await buildPackage(p,async id=>{assert.equal(id,doc.documentId);return bytes},dir,new AbortController().signal,new Date('2026-11-06T00:00:00Z'));
    const entries=readZip(await readFile(built.zipPath));
    assert.deepEqual([...entries.keys()].sort(),['anexos/'+doc.documentId+'.pdf','manifesto.json','movimentacoes.csv','resumo.html']);
    assert.ok(entries.get('manifesto.json').equals(built.manifest));assert.equal(built.manifestHash,sha(built.manifest));assert.equal(built.zipHash,sha(await readFile(built.zipPath)));
    const manifest=JSON.parse(built.manifest.toString('utf8'));
    assert.equal(manifest.schemaVersion,'mimir.manifest.v2');assert.equal(manifest.generatedAt,'2026-11-06T00:00:00.000Z');
    assert.deepEqual(manifest.files.map(f=>f.path),[`anexos/${doc.documentId}.pdf`,'movimentacoes.csv','resumo.html']);
    for(const file of manifest.files){const data=entries.get(file.path);assert.equal(file.sizeBytes,data.length);assert.equal(file.sha256,sha(data));}
    assert.deepEqual(manifest.files[0].inclusionReasons,['VINCULO_DIRETO_PERIODO']);assert.equal(manifest.files[0].documentId,doc.documentId);
    assert.deepEqual(manifest.transactions,p.transactions);assert.deepEqual(manifest.summary,p.summary);assert.deepEqual(manifest.delivery,p.delivery);
    assert.equal(manifest.transactions[0].accountName,'=Conta, "PF"');
    assert.ok(buildManifest(p,Buffer.from('a'),Buffer.from('b'),new Date(0)).length>0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('I08 packaging: integrity, abort, empty and size limits fail without leaving a usable package',async()=>{
  const {buildPackage}=await import('../../apps/api/dist/packaging/build.js').catch(()=>({}));assert.ok(buildPackage,'I08 packaging missing');
  const {ZipFileWriter,PackagingError}=await import('../../apps/api/dist/packaging/zip.js');
  const bytes=Buffer.from('%PDF-1.7\nSynthetic I08\n%%EOF\n'),doc=document(bytes),p=payload([doc]);
  const dir=await mkdtemp(join(tmpdir(),'mimir-i08-'));
  try{
    await assert.rejects(buildPackage(p,async()=>Buffer.from('%PDF-1.7\nAltered I08\n%%EOF\n'),join(dir,'a'),new AbortController().signal),e=>e.code==='DOCUMENT_INTEGRITY');
    const controller=new AbortController();
    await assert.rejects(buildPackage(p,async()=>{controller.abort();return bytes},join(dir,'b'),controller.signal),e=>e.name==='AbortError');
    await assert.rejects(buildPackage({...p,transactions:[]},async()=>bytes,join(dir,'c'),new AbortController().signal),e=>e.code==='SNAPSHOT_INVALID');
    const big=payload([doc]);big.transactions[0].explanationOriginal='x'.repeat(9*1024*1024);
    await assert.rejects(buildPackage(big,async()=>bytes,join(dir,'d'),new AbortController().signal),e=>e.code==='MANIFEST_TOO_LARGE');
    const tooMany={...p,documents:Array.from({length:1001},()=>doc)};
    await assert.rejects(buildPackage(tooMany,async()=>bytes,join(dir,'e'),new AbortController().signal),e=>e.code==='PACKAGE_TOO_LARGE');
    const writer=await ZipFileWriter.create(join(dir,'small.zip'),new Date(),400);
    await writer.add({path:'a.txt',data:Buffer.from('small'),compress:false});
    await assert.rejects(writer.add({path:'b.bin',data:Buffer.alloc(1000,7),compress:false}),e=>e instanceof PackagingError&&e.code==='PACKAGE_TOO_LARGE');
    await writer.abort();
    const names=await readdir(dir);assert.ok(names.includes('small.zip'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('I11 packaging: reimbursement link and context reach HTML/manifest, stay out of CSV and pass the offline verifier',async()=>{
  const {buildPackage}=await import('../../apps/api/dist/packaging/build.js');
  const {verifyDeliveryPackage}=await import('../../packages/verifier/dist/verifier.js');
  const {mkdir,writeFile}=await import('node:fs/promises');
  const pfDoc=Buffer.from('%PDF-1.7\nSynthetic I11 origem\n%%EOF\n'),pjDoc=Buffer.from('%PDF-1.7\nSynthetic I11 PJ\n%%EOF\n');
  const d1=document(pfDoc),d2=document(pjDoc,'transferencia.pdf'),pfAccount=randomUUID(),pjAccount=randomUUID();
  const base={accountName:'Conta PF',accountType:'PF',accountId:pfAccount,sourceType:'MANUAL',sourceCode:'MANUAL',explanationOriginal:'',isPfBusinessExpense:false};
  const expense={...base,transactionId:randomUUID(),occurredOn:'2026-10-10',direction:'SAIDA',amountCents:10000,descriptionOriginal:'Despesa da empresa',categoryOriginal:'INFRAESTRUTURA',
    classification:'DESPESA',isPfBusinessExpense:true,documentIds:[d1.documentId],reimbursementStatus:'REEMBOLSADA_OUTRO_MES'};
  expense.externalId=expense.transactionId;
  const outflow={...base,accountName:'Conta PJ',accountType:'PJ',accountId:pjAccount,transactionId:randomUUID(),occurredOn:'2026-11-05',direction:'SAIDA',amountCents:10000,
    descriptionOriginal:'Reembolso PF',categoryOriginal:'TRANSFERENCIAS',classification:'TRANSFERENCIA',documentIds:[d2.documentId],reimbursementStatus:'LIQUIDACAO_DE_REEMBOLSO'};
  outflow.externalId=outflow.transactionId;
  const inflow={...base,transactionId:randomUUID(),occurredOn:'2026-11-06',direction:'ENTRADA',amountCents:10000,descriptionOriginal:'Entrada do reembolso',
    categoryOriginal:'TRANSFERENCIAS',classification:'TRANSFERENCIA',documentIds:[],reimbursementStatus:'LIQUIDACAO_DE_REEMBOLSO'};
  inflow.externalId=inflow.transactionId;
  const link={reimbursementLinkId:randomUUID(),pfExpenseTransactionId:expense.transactionId,pjReimbursementTransactionId:outflow.transactionId,
    pfInflowTransactionId:inflow.transactionId,amountCents:10000,pfOriginDocumentIds:[d1.documentId],roleInPeriod:'DESPESA_ORIGEM_NO_PERIODO'};
  const p={schemaVersion:'mimir.snapshot.v1',workspace:{workspaceId:randomUUID(),companyName:'Empresa Sintetica',currency:'BRL'},
    delivery:{snapshotId:randomUUID(),operationId:randomUUID(),periodMonth:'2026-10',versionNumber:2,capturedRevision:9,rectificationReason:'Inclui reembolso',capturedAt:'2026-11-07T12:00:00.000Z'},
    summary:{cashFlowByAccount:[{accountId:pfAccount,accountName:'Conta PF',accountType:'PF',inflowCents:0,outflowCents:10000,netCents:-10000}],businessRevenueTotalCents:0,
      businessExpenseTotalCents:10000,reimbursementsSettledInPeriodCents:0,pendingCount:0,justifiedCount:0,categoryTotals:[{category:'INFRAESTRUTURA',inflowCents:0,outflowCents:10000,netCents:-10000}]},
    transactions:[expense],contextTransactions:[outflow,inflow],reimbursementLinks:[link],
    pendingItems:[{pendingId:randomUUID(),transactionId:expense.transactionId,pendingType:'REEMBOLSO_PF_PENDENTE',status:'RESOLVIDA',description:'Despesa empresarial PF sem vínculo de reembolso.',justification:''}],
    documents:[d1,d2].sort((a,b)=>a.documentId<b.documentId?-1:1),period:{periodMonth:'2026-10',notes:''}};
  const dir=await mkdtemp(join(tmpdir(),'mimir-i11-'));
  try{
    const built=await buildPackage(p,async id=>id===d1.documentId?pfDoc:pjDoc,join(dir,'work'),new AbortController().signal,new Date('2026-11-07T12:00:01Z'));
    const entries=readZip(await readFile(built.zipPath)),extracted=join(dir,'pkg');
    for(const [name,data] of entries){await mkdir(join(extracted,name,'..'),{recursive:true});await writeFile(join(extracted,name),data);}
    const sheet=entries.get('movimentacoes.csv').toString('utf8');
    assert.equal(sheet.split('\r\n').length,3,'CSV keeps only the principal movement');assert.ok(!sheet.includes(outflow.transactionId));assert.ok(!sheet.includes(inflow.transactionId));
    const html=entries.get('resumo.html').toString('utf8');
    assert.ok(html.includes(`<td>${link.reimbursementLinkId}</td>`));assert.ok(html.includes(`<td>${inflow.transactionId}</td>`));assert.ok(html.includes('DESPESA_ORIGEM_NO_PERIODO'));
    const manifest=JSON.parse(built.manifest.toString('utf8'));
    assert.deepEqual(manifest.files.find(f=>f.documentId===d2.documentId).inclusionReasons,['CONTEXTO_REEMBOLSO']);
    assert.deepEqual(manifest.files.find(f=>f.documentId===d1.documentId).inclusionReasons,['VINCULO_DIRETO_PERIODO']);
    await writeFile(join(dir,'ref.manifesto.json'),built.manifest);
    const verified=await verifyDeliveryPackage(extracted,join(dir,'ref.manifesto.json'));
    assert.equal(verified.ok,true,verified.message);assert.equal(verified.counts.contextTransactions,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});
