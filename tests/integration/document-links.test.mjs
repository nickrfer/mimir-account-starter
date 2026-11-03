import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import pg from 'pg';
import {createOwner} from '../../tools/admin/owners.mjs';
import {PostgresAuthentication} from '../../apps/api/dist/adapters/postgres-auth.js';
import {PostgresPersistence} from '../../apps/api/dist/adapters/postgres.js';
import {PostgresAccounts} from '../../apps/api/dist/adapters/postgres-accounts.js';
import {PostgresTransactions} from '../../apps/api/dist/adapters/postgres-transactions.js';
import {PostgresDocuments} from '../../apps/api/dist/adapters/postgres-documents.js';
import {PostgresPreview} from '../../apps/api/dist/adapters/postgres-preview.js';
import {PostgresDeliveries} from '../../apps/api/dist/adapters/postgres-deliveries.js';
import {PostgresReimbursements} from '../../apps/api/dist/adapters/postgres-reimbursements.js';
import {PostgresPendingItems} from '../../apps/api/dist/adapters/postgres-pending-items.js';
import {PostgresExecutor} from '../../apps/api/dist/adapters/postgres-executor.js';
import {DeliveryExecutor} from '../../apps/api/dist/executor/runner.js';
import {AuthenticationService} from '../../apps/api/dist/auth/service.js';
import {createApp} from '../../apps/api/dist/server.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const pdf=label=>Buffer.from(`%PDF-1.7\nSynthetic I15 ${label}\n%%EOF\n`);
function readZip(bytes){
  const end=bytes.length-22,count=bytes.readUInt16LE(end+10);let at=bytes.readUInt32LE(end+16);const entries=new Map();
  for(let i=0;i<count;i++){
    const method=bytes.readUInt16LE(at+10),csize=bytes.readUInt32LE(at+20),nameLength=bytes.readUInt16LE(at+28),offset=bytes.readUInt32LE(at+42);
    const name=bytes.subarray(at+46,at+46+nameLength).toString('utf8'),start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28),raw=bytes.subarray(start,start+csize);
    entries.set(name,method===8?inflateRawSync(raw):raw);at+=46+nameLength;
  }
  return entries;
}

test('I15 complementary documents: HTTP and PostgreSQL',async t=>{
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  const url=new URL(process.env.MIGRATION_DATABASE_URL);url.username='mimir_runtime';url.password=process.env.APP_ROLE_PASSWORD;const runtimeUrl=url.toString();
  const auth=new PostgresAuthentication(runtimeUrl),persistence=new PostgresPersistence(runtimeUrl),accounts=new PostgresAccounts(runtimeUrl);
  const transactions=new PostgresTransactions(runtimeUrl),documents=new PostgresDocuments(runtimeUrl),preview=new PostgresPreview(runtimeUrl);
  const deliveries=new PostgresDeliveries(runtimeUrl),reimbursements=new PostgresReimbursements(runtimeUrl),pendingItems=new PostgresPendingItems(runtimeUrl);
  const scope=new Set(),executorPort=new PostgresExecutor(runtimeUrl,scope),workRoot=await mkdtemp(join(tmpdir(),'mimir-i15-work-'));
  const service=await AuthenticationService.create(auth),origin='http://127.0.0.1:3000';
  const server=createApp(persistence,fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),{service,origins:new Set([origin]),allowLocalHttp:true,log:()=>{}},
    accounts,transactions,documents,preview,deliveries,reimbursements,pendingItems);
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));
    await Promise.all([admin.end(),auth.close(),persistence.close(),accounts.close(),transactions.close(),documents.close(),preview.close(),deliveries.close(),reimbursements.close(),pendingItems.close(),executorPort.close()]);
    await rm(workRoot,{recursive:true,force:true});});
  const password=randomBytes(24).toString('hex');
  async function owner(label){
    const email=`${randomUUID()}@example.invalid`,identity=await createOwner({email,password,displayName:label,companyName:label});scope.add(identity.workspaceId);
    const r=await fetch(base+'/api/v1/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);
    return {...identity,token:r.headers.get('set-cookie').match(/^mimir_session=([a-f0-9]{64});/)[1],csrf:(await r.json()).csrfToken};
  }
  const headers=(who,extra={})=>({Origin:origin,Cookie:`mimir_session=${who.token}`,'X-CSRF-Token':who.csrf,...extra});
  const json=who=>headers(who,{'Content-Type':'application/json'});
  const revision=async who=>Number((await admin.query('SELECT revision::text n FROM mimir.workspaces WHERE id=$1',[who.workspaceId])).rows[0].n);
  async function account(who,type){
    const r=await fetch(base+'/api/v1/accounts',{method:'POST',headers:json(who),body:JSON.stringify({name:`Synthetic ${type} ${randomUUID()}`,accountType:type,expectedRevision:await revision(who)})});
    assert.equal(r.status,201);return (await r.json()).account.id;
  }
  async function tx(who,accountId,fields={}){
    const body={accountId,occurredOn:fields.date??'2026-09-05',direction:fields.direction??'SAIDA',amountCents:fields.amount??10000,description:fields.description??'Synthetic I15',
      category:'GERAL',classification:fields.classification??'DESPESA',isPfBusinessExpense:fields.business??false,explanation:'',expectedRevision:await revision(who)};
    const r=await fetch(base+'/api/v1/transactions',{method:'POST',headers:json(who),body:JSON.stringify(body)});assert.equal(r.status,201);
    return (await r.json()).transaction.transactionId;
  }
  async function upload(who,id,label='doc'){
    const body=new FormData();body.append('file',new Blob([pdf(label)],{type:'application/pdf'}),`${label}.pdf`);body.append('expectedRevision',String(await revision(who)));
    const r=await fetch(base+`/api/v1/transactions/${id}/documents`,{method:'POST',headers:headers(who),body});assert.equal(r.status,201);return (await r.json()).documentId;
  }
  const list=(who,month='2026-09')=>fetch(base+`/api/v1/documents?periodMonth=${month}`,{headers:headers(who)});
  const content=(who,id)=>fetch(base+`/api/v1/documents/${id}/content`,{headers:headers(who)});
  const link=async(who,id,documentId,rev)=>fetch(base+`/api/v1/transactions/${id}/document-links`,{method:'POST',headers:json(who),body:JSON.stringify({documentId,expectedRevision:rev??await revision(who)})});
  const unlink=async(who,id,documentId,rev)=>fetch(base+`/api/v1/transactions/${id}/document-links/${documentId}`,{method:'DELETE',headers:json(who),body:JSON.stringify({expectedRevision:rev??await revision(who)})});
  async function replace(who,id,replacedDocumentId,{bytes=pdf('novo'),name='novo.pdf',mime='application/pdf',rev}={}){
    const body=new FormData();body.append('file',new Blob([bytes],{type:mime}),name);body.append('replacedDocumentId',replacedDocumentId);
    body.append('expectedRevision',String(rev??await revision(who)));
    return fetch(base+`/api/v1/transactions/${id}/document-replacements`,{method:'POST',headers:headers(who),body});
  }
  const links=async id=>(await admin.query('SELECT document_id::text FROM mimir.transaction_documents WHERE transaction_id=$1 ORDER BY document_id',[id])).rows.map(r=>r.document_id);
  const pendings=async id=>Object.fromEntries((await admin.query('SELECT type,status,justification FROM mimir.pending_items WHERE transaction_id=$1',[id])).rows.map(r=>[r.type,[r.status,r.justification]]));
  const documentCount=async who=>(await admin.query('SELECT count(*)::int n FROM mimir.documents WHERE workspace_id=$1',[who.workspaceId])).rows[0].n;
  const code=async(r,status,expected)=>{assert.equal(r.status,status);if(expected)assert.equal((await r.json()).code,expected);};
  const unchanged=async(who,work)=>{const rev=await revision(who),docs=await documentCount(who);await work();assert.equal(await revision(who),rev);assert.equal(await documentCount(who),docs);};

  const a=await owner('Synthetic I15 A'),b=await owner('Synthetic I15 B');
  const pjA=await account(a,'PJ'),pjB=await account(b,'PJ');

  await t.test('US1 listing: month documents with active transactions only, ordered, with revision; foreign isolated',async()=>{
    const t1=await tx(a,pjA),t2=await tx(a,pjA),old=await tx(a,pjA,{date:'2026-08-30'});
    const d1=await upload(a,t1,'um'),d2=await upload(a,t2,'dois'),d3=await upload(a,old,'agosto');
    assert.equal((await link(a,t2,d1)).status,201);
    const r=await list(a);assert.equal(r.status,200);const body=await r.json();
    assert.equal(body.periodMonth,'2026-09');assert.equal(body.revision,await revision(a));
    const ids=body.documents.map(d=>d.documentId);assert.deepEqual(ids,[d1,d2]);
    assert.deepEqual(body.documents[0].transactionIds,[t1,t2].sort());assert.deepEqual(body.documents[1].transactionIds,[t2]);
    const first=body.documents[0];
    assert.deepEqual(Object.keys(first).sort(),['createdAt','documentId','mimeType','originalName','sha256','sizeBytes','supersedesDocumentId','transactionIds']);
    assert.equal(first.originalName,'um.pdf');assert.equal(first.mimeType,'application/pdf');assert.equal(first.sha256,sha(pdf('um')));assert.equal(first.supersedesDocumentId,null);
    assert.ok(!ids.includes(d3));
    const del=await fetch(base+`/api/v1/transactions/${t2}`,{method:'DELETE',headers:json(a),body:JSON.stringify({expectedRevision:await revision(a)})});assert.equal(del.status,200);
    assert.deepEqual((await (await list(a)).json()).documents.map(d=>[d.documentId,d.transactionIds]),[[d1,[t1]]]);
    assert.deepEqual((await (await list(b)).json()).documents,[]);
    await code(await fetch(base+'/api/v1/documents?periodMonth=2026-13',{headers:headers(a)}),422,'INVALID_MONTH');
    await code(await fetch(base+'/api/v1/documents',{headers:headers(a)}),400,'INVALID_QUERY');
    await code(await fetch(base+'/api/v1/documents?periodMonth=2026-09&x=1',{headers:headers(a)}),400,'INVALID_QUERY');
    await code(await fetch(base+'/api/v1/documents?periodMonth=2026-09'),401);
  });

  await t.test('US1 download: same bytes and hash, attachment, octet-stream, sandbox; foreign and unknown 404',async()=>{
    const id=await tx(a,pjA),doc=await upload(a,id,'baixar');
    const r=await content(a,doc);assert.equal(r.status,200);
    const bytes=Buffer.from(await r.arrayBuffer());assert.ok(bytes.equals(pdf('baixar')));
    assert.equal(r.headers.get('content-type'),'application/octet-stream');assert.equal(r.headers.get('content-disposition'),`attachment; filename="documento-${doc}.pdf"`);
    assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(r.headers.get('content-security-policy'),"default-src 'none'; sandbox");
    assert.equal(r.headers.get('x-content-sha256'),sha(bytes));assert.equal(r.headers.get('cache-control'),'no-store');
    assert.equal(r.headers.get('cross-origin-resource-policy'),'same-origin');
    await code(await content(b,doc),404,'NOT_FOUND');await code(await content(a,randomUUID()),404,'NOT_FOUND');
    await code(await content(a,'x'),422,'INVALID_ID');await code(await fetch(base+`/api/v1/documents/${doc}/content`),401);
    await code(await fetch(base+`/api/v1/documents/${doc}/content`,{method:'POST',headers:headers(a)}),405,'METHOD_NOT_ALLOWED');
    assert.equal((await unlink(a,id,doc)).status,200);
    assert.equal((await content(a,doc)).status,200,'documento sem vínculo continua baixável');
  });

  await t.test('US2 replace: new id superseding old, only this link swapped, other use kept, pendings, errors without writes',async()=>{
    const id=await tx(a,pjA),other=await tx(a,pjA),old=await upload(a,id,'errado');
    assert.equal((await link(a,other,old)).status,201);
    const before=await revision(a),r=await replace(a,id,old);assert.equal(r.status,201);const body=await r.json();
    assert.deepEqual(Object.keys(body).sort(),['documentId','replacedDocumentId','revision','sha256','sizeBytes','transactionId']);
    assert.notEqual(body.documentId,old);assert.equal(body.replacedDocumentId,old);assert.equal(body.revision,before+1);assert.equal(await revision(a),before+1);
    assert.equal(body.sha256,sha(pdf('novo')));
    assert.deepEqual(await links(id),[body.documentId]);assert.deepEqual(await links(other),[old]);
    const row=(await admin.query('SELECT supersedes_document_id::text s FROM mimir.documents WHERE id=$1',[body.documentId])).rows[0];assert.equal(row.s,old);
    assert.ok(Buffer.from(await (await content(a,old)).arrayBuffer()).equals(pdf('errado')),'documento anterior intacto');
    assert.deepEqual((await pendings(id)).DOCUMENTO_AUSENTE[0],'RESOLVIDA');
    await unchanged(a,async()=>{
      await code(await replace(a,id,old),409,'DOCUMENT_NOT_LINKED');
      await code(await replace(a,id,randomUUID()),404,'NOT_FOUND');
      await code(await replace(a,randomUUID(),body.documentId),404,'NOT_FOUND');
      await code(await replace(a,id,body.documentId,{rev:before}),409,'REVISION_CONFLICT');
      await code(await replace(a,id,body.documentId,{bytes:Buffer.from('nao e pdf'),name:'x.pdf'}),422,'INVALID_INPUT');
      await code(await replace(a,id,body.documentId,{name:'x.exe'}),415,'UNSUPPORTED_MEDIA_TYPE');
      await code(await replace(b,id,body.documentId),404,'NOT_FOUND');
    });
    const gone=await tx(a,pjA),goneDoc=await upload(a,gone,'gone');
    assert.equal((await fetch(base+`/api/v1/transactions/${gone}`,{method:'DELETE',headers:json(a),body:JSON.stringify({expectedRevision:await revision(a)})})).status,200);
    await unchanged(a,async()=>code(await replace(a,gone,goneDoc),409,'TRANSACTION_INACTIVE'));
  });

  await t.test('US3 unlink: last document reopens or creates missing-document pending; document preserved; transfer creates none',async()=>{
    const id=await tx(a,pjA),doc=await upload(a,id,'unico');
    await admin.query(`UPDATE mimir.pending_items SET justification='antiga' WHERE transaction_id=$1 AND type='DOCUMENTO_AUSENTE'`,[id]);
    const before=await revision(a),r=await unlink(a,id,doc);assert.equal(r.status,200);
    assert.deepEqual(await r.json(),{transactionId:id,documentId:doc,revision:before+1});
    assert.deepEqual((await pendings(id)).DOCUMENTO_AUSENTE,['PENDENTE','']);assert.deepEqual(await links(id),[]);
    assert.equal((await admin.query('SELECT count(*)::int n FROM mimir.documents WHERE id=$1',[doc])).rows[0].n,1);
    const two=await tx(a,pjA),x=await upload(a,two,'x');await upload(a,two,'y');
    assert.equal((await unlink(a,two,x)).status,200);assert.deepEqual((await pendings(two)).DOCUMENTO_AUSENTE[0],'RESOLVIDA');
    const transfer=await tx(a,pjA,{classification:'TRANSFERENCIA'}),tdoc=await upload(a,transfer,'t');
    assert.equal((await unlink(a,transfer,tdoc)).status,200);assert.deepEqual(await pendings(transfer),{});
    const created=await tx(a,pjA),cdoc=await upload(a,created,'c');
    await admin.query(`DELETE FROM mimir.pending_items WHERE transaction_id=$1 AND type='DOCUMENTO_AUSENTE'`,[created]);
    assert.equal((await unlink(a,created,cdoc)).status,200);assert.deepEqual((await pendings(created)).DOCUMENTO_AUSENTE,['PENDENTE','']);
    await unchanged(a,async()=>{
      await code(await unlink(a,id,doc),404,'NOT_FOUND');
      await code(await unlink(a,two,randomUUID()),404,'NOT_FOUND');
      await code(await unlink(b,two,x),404,'NOT_FOUND');
      await code(await unlink(a,two,x,1),404,'NOT_FOUND');
      await code(await fetch(base+`/api/v1/transactions/${two}/document-links/x`,{method:'DELETE',headers:json(a),body:JSON.stringify({expectedRevision:await revision(a)})}),422,'INVALID_ID');
      await code(await fetch(base+`/api/v1/transactions/${two}/document-links/${x}`,{method:'DELETE',headers:json(a),body:JSON.stringify({})}),422,'INVALID_INPUT');
    });
    const kept=(await (await list(a)).json()).documents.find(d=>d.transactionIds.includes(two));
    await unchanged(a,async()=>code(await unlink(a,two,kept.documentId,1),409,'REVISION_CONFLICT'));
  });

  await t.test('US3/US4 material change reopens justified automatic pendings; manual question unchanged',async()=>{
    const pf=await account(a,'PF'),id=await tx(a,pf,{business:true}),doc=await upload(a,id,'pf');
    await admin.query(`UPDATE mimir.pending_items SET status='JUSTIFICADA',justification='Sócio pagou' WHERE transaction_id=$1 AND type='REEMBOLSO_PF_PENDENTE'`,[id]);
    assert.equal((await fetch(base+`/api/v1/transactions/${id}/questions`,{method:'POST',headers:json(a),body:JSON.stringify({description:'Conferir nota',expectedRevision:await revision(a)})})).status,201);
    assert.equal((await unlink(a,id,doc)).status,200);
    const after=await pendings(id);assert.deepEqual(after.REEMBOLSO_PF_PENDENTE,['PENDENTE','']);assert.deepEqual(after.DUVIDA_CADASTRADA,['PENDENTE','']);
    await admin.query(`UPDATE mimir.pending_items SET status='JUSTIFICADA',justification='Sócio pagou' WHERE transaction_id=$1 AND type='REEMBOLSO_PF_PENDENTE'`,[id]);
    assert.equal((await link(a,id,doc)).status,201);
    const linked=await pendings(id);assert.deepEqual(linked.REEMBOLSO_PF_PENDENTE,['PENDENTE','']);assert.equal(linked.DOCUMENTO_AUSENTE[0],'RESOLVIDA');
  });

  await t.test('US4 link existing: resolves missing document, duplicate 409, foreign 404, inactive 409',async()=>{
    const src=await tx(a,pjA),dst=await tx(a,pjA),doc=await upload(a,src,'reuso');
    assert.equal((await pendings(dst)).DOCUMENTO_AUSENTE[0],'PENDENTE');
    const before=await revision(a),r=await link(a,dst,doc);assert.equal(r.status,201);
    assert.deepEqual(await r.json(),{transactionId:dst,documentId:doc,revision:before+1});
    assert.deepEqual(await links(dst),[doc]);assert.equal((await pendings(dst)).DOCUMENTO_AUSENTE[0],'RESOLVIDA');
    const foreignTx=await tx(b,pjB),foreignDoc=await upload(b,foreignTx,'alheio');
    await unchanged(a,async()=>{
      await code(await link(a,dst,doc),409,'DOCUMENT_ALREADY_LINKED');
      await code(await link(a,dst,foreignDoc),404,'NOT_FOUND');
      await code(await link(a,foreignTx,doc),404,'NOT_FOUND');
      await code(await link(a,dst,doc,before),409,'REVISION_CONFLICT');
      await code(await fetch(base+`/api/v1/transactions/${dst}/document-links`,{method:'POST',headers:json(a),body:JSON.stringify({documentId:doc,expectedRevision:await revision(a),x:1})}),422,'INVALID_INPUT');
      await code(await fetch(base+`/api/v1/transactions/${dst}/document-links`,{method:'POST',headers:headers(a,{'Content-Type':'text/plain'}),body:'{}'}),415);
    });
    assert.equal((await fetch(base+`/api/v1/transactions/${src}`,{method:'DELETE',headers:json(a),body:JSON.stringify({expectedRevision:await revision(a)})})).status,200);
    const third=await tx(a,pjA);
    await unchanged(a,async()=>code(await link(a,src,(await (await list(a)).json()).documents[0].documentId),409,'TRANSACTION_INACTIVE'));
    assert.equal((await link(a,third,doc)).status,201,'documento de lançamento excluído continua reutilizável');
  });

  await t.test('security: session, CSRF and Origin on all mutations; concurrency with the same revision',async()=>{
    const id=await tx(a,pjA),doc=await upload(a,id,'sec'),dst=await tx(a,pjA);
    await unchanged(a,async()=>{
      const rev=await revision(a);
      for(const [path,method,body] of [[`/api/v1/transactions/${dst}/document-links`,'POST',JSON.stringify({documentId:doc,expectedRevision:rev})],
        [`/api/v1/transactions/${id}/document-links/${doc}`,'DELETE',JSON.stringify({expectedRevision:rev})]]){
        await code(await fetch(base+path,{method,headers:{Origin:origin,'Content-Type':'application/json'},body}),401);
        await code(await fetch(base+path,{method,headers:{...json(a),'X-CSRF-Token':'0'.repeat(64)},body}),403);
        await code(await fetch(base+path,{method,headers:{...json(a),Origin:'http://evil.invalid'},body}),403);
        await code(await fetch(base+path,{method,headers:{Cookie:`mimir_session=${a.token}`,'X-CSRF-Token':a.csrf,'Content-Type':'application/json'},body}),403);
      }
      const form=new FormData();form.append('file',new Blob([pdf('s')],{type:'application/pdf'}),'s.pdf');form.append('replacedDocumentId',doc);form.append('expectedRevision',String(rev));
      await code(await fetch(base+`/api/v1/transactions/${id}/document-replacements`,{method:'POST',headers:{Origin:origin,Cookie:`mimir_session=${a.token}`},body:form}),403);
    });
    const rev=await revision(a),others=[await tx(a,pjA),await tx(a,pjA),await tx(a,pjA)];
    const current=await revision(a);
    const results=await Promise.all(others.map(o=>link(a,o,doc,current)));
    assert.deepEqual(results.map(r=>r.status).sort(),[201,409,409]);assert.equal(await revision(a),current+1);assert.ok(rev<current);
  });

  await t.test('runtime cannot alter or delete documents; links are its only deletable rows',async()=>{
    const id=await tx(a,pjA),doc=await upload(a,id,'grant');
    const runtime=new pg.Client({connectionString:runtimeUrl});await runtime.connect();
    try{
      await assert.rejects(runtime.query(`UPDATE mimir.documents SET original_name='x.pdf' WHERE id=$1`,[doc]),e=>e.code==='42501');
      await assert.rejects(runtime.query('DELETE FROM mimir.documents WHERE id=$1',[doc]),e=>e.code==='42501');
      await assert.rejects(runtime.query('UPDATE mimir.transaction_documents SET document_id=document_id WHERE document_id=$1',[doc]),e=>e.code==='42501');
    }finally{await runtime.end();}
  });

  await t.test('active reimbursement link does not block documentary changes on PF expense or PJ outflow',async()=>{
    const pf=await account(a,'PF'),expense=await tx(a,pf,{business:true,date:'2026-09-10'}),outflow=await tx(a,pjA,{classification:'TRANSFERENCIA',date:'2026-09-20'});
    const r=await fetch(base+'/api/v1/reimbursements',{method:'POST',headers:json(a),body:JSON.stringify({pfExpenseTransactionId:expense,pjReimbursementTransactionId:outflow,pfInflowTransactionId:null,notes:'',expectedRevision:await revision(a)})});
    assert.equal(r.status,201);
    const e=await upload(a,expense,'origem'),o=await upload(a,outflow,'pix');
    const n=await replace(a,expense,e,{bytes:pdf('origem2'),name:'origem2.pdf'});assert.equal(n.status,201);const replacement=(await n.json()).documentId;
    assert.equal((await unlink(a,outflow,o)).status,200);assert.deepEqual(await pendings(outflow),{});
    assert.equal((await link(a,outflow,replacement)).status,201);
    assert.equal((await unlink(a,expense,replacement)).status,200);
    const after=await pendings(expense);assert.deepEqual(after.DOCUMENTO_AUSENTE,['PENDENTE','']);assert.equal(after.REEMBOLSO_PF_PENDENTE[0],'RESOLVIDA');
    assert.equal((await admin.query(`SELECT count(*)::int n FROM mimir.reimbursement_links WHERE pf_expense_id=$1 AND status='ATIVO'`,[expense])).rows[0].n,1);
  });

  await t.test('replacement admission: 413 oversize, 429 beyond two waiting, reservations released after failures',async()=>{
    const id=await tx(a,pjA),doc=await upload(a,id,'adm');
    await unchanged(a,async()=>code(await replace(a,id,doc,{bytes:Buffer.concat([Buffer.from('%PDF-'),Buffer.alloc(5242880)]),name:'big.pdf'}),413,'REQUEST_TOO_LARGE'));
    await unchanged(a,async()=>code(await replace(a,id,doc,{name:'x.exe',bytes:pdf('x')}),415,'UNSUPPORTED_MEDIA_TYPE'));
    const rev=await revision(a),supervisor=new pg.Client({connectionString:process.env.PROVISION_DATABASE_URL});await supervisor.connect();
    await admin.query('BEGIN');let responses=[];
    try{
      await admin.query('SELECT id FROM mimir.workspaces WHERE id=$1 FOR UPDATE',[a.workspaceId]);
      responses=[replace(a,id,doc,{rev}),replace(a,id,doc,{rev})];
      const until=Date.now()+1200;let waiting=0;
      while(Date.now()<until){waiting=(await supervisor.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='mimir-documents' AND wait_event_type='Lock'")).rows[0].n;if(waiting===2)break;await sleep(10);}
      assert.equal(waiting,2);
      const excess=await replace(a,id,doc,{rev});assert.equal(excess.status,429);assert.equal(excess.headers.get('retry-after'),'1');assert.equal((await excess.json()).code,'UPLOAD_LIMIT');
      await admin.query('COMMIT');
      const statuses=(await Promise.all(responses)).map(r=>r.status).sort();assert.deepEqual(statuses,[201,409]);
    }finally{await admin.query('ROLLBACK');await Promise.all(responses);await supervisor.end();}
    for(let i=0;i<3;i++)await code(await replace(a,id,randomUUID()),404,'NOT_FOUND');
    const current=(await links(id))[0];
    assert.equal((await replace(a,id,current)).status,201,'reservas liberadas após falhas');
  });

  await t.test('deliveries: earlier package byte-identical after replace and unlink; new capture has one file with two references',async()=>{
    const d=await owner('Synthetic I15 D'),pj=await account(d,'PJ');
    const t1=await tx(d,pj,{date:'2026-07-05'}),t2=await tx(d,pj,{date:'2026-07-06'}),old=await upload(d,t1,'original');await upload(d,t2,'outro');
    const worker=new DeliveryExecutor(executorPort,{workRoot,pollMs:50,renewMs:50});
    async function capture(reason=''){
      const r=await fetch(base+'/api/v1/deliveries',{method:'POST',headers:{...json(d),'Idempotency-Key':randomUUID()},body:JSON.stringify({periodMonth:'2026-07',expectedRevision:await revision(d),rectificationReason:reason})});
      assert.equal(r.status,202);const op=await r.json();
      for(let i=0;i<80;i++){const s=await (await fetch(base+`/api/v1/operations/${op.id}`,{headers:headers(d)})).json();if(s.status==='PRONTA')return op;assert.notEqual(s.status,'FALHA');await worker.tick();await sleep(60);}
      assert.fail('delivery not ready');
    }
    const download=async(op,kind)=>Buffer.from(await (await fetch(base+`/api/v1/deliveries/${op.snapshotId}/${kind}`,{headers:headers(d)})).arrayBuffer());
    const v1=await capture(),v1Zip=await download(v1,'package'),v1Manifest=await download(v1,'manifest');
    const r=await replace(d,t1,old,{bytes:pdf('corrigido'),name:'corrigido.pdf'});assert.equal(r.status,201);const replacement=(await r.json()).documentId;
    const t2Doc=(await links(t2))[0];assert.equal((await unlink(d,t2,t2Doc)).status,200);
    assert.equal((await link(d,t2,replacement)).status,201);
    assert.ok((await download(v1,'package')).equals(v1Zip));assert.ok((await download(v1,'manifest')).equals(v1Manifest));
    assert.ok(readZip(v1Zip).get(`anexos/${old}.pdf`).equals(pdf('original')));
    const v2=await capture('Comprovante substituído'),zip=readZip(await download(v2,'package')),manifest=JSON.parse((await download(v2,'manifest')).toString('utf8'));
    const attachments=[...zip.keys()].filter(k=>k.startsWith('anexos/'));
    assert.deepEqual(attachments,[`anexos/${replacement}.pdf`]);assert.ok(zip.get(`anexos/${replacement}.pdf`).equals(pdf('corrigido')));
    assert.deepEqual(manifest.transactions.map(x=>x.documentIds).sort(),[[replacement],[replacement]]);
  });
});
