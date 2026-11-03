import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
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
import {verifyDeliveryPackage} from '../../packages/verifier/dist/verifier.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function readZip(bytes){
  const end=bytes.length-22,count=bytes.readUInt16LE(end+10);let at=bytes.readUInt32LE(end+16);const entries=new Map();
  for(let i=0;i<count;i++){
    const method=bytes.readUInt16LE(at+10),csize=bytes.readUInt32LE(at+20),nameLength=bytes.readUInt16LE(at+28),offset=bytes.readUInt32LE(at+42);
    const name=bytes.subarray(at+46,at+46+nameLength).toString('utf8'),start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28),raw=bytes.subarray(start,start+csize);
    entries.set(name,method===8?inflateRawSync(raw):raw);at+=46+nameLength;
  }
  return entries;
}

test('I13 pending item lifecycle: HTTP and PostgreSQL',async t=>{
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  const url=new URL(process.env.MIGRATION_DATABASE_URL);url.username='mimir_runtime';url.password=process.env.APP_ROLE_PASSWORD;const runtimeUrl=url.toString();
  const auth=new PostgresAuthentication(runtimeUrl),persistence=new PostgresPersistence(runtimeUrl),accounts=new PostgresAccounts(runtimeUrl);
  const transactions=new PostgresTransactions(runtimeUrl),documents=new PostgresDocuments(runtimeUrl),preview=new PostgresPreview(runtimeUrl);
  const deliveries=new PostgresDeliveries(runtimeUrl),reimbursements=new PostgresReimbursements(runtimeUrl),pendingItems=new PostgresPendingItems(runtimeUrl);
  const scope=new Set(),executorPort=new PostgresExecutor(runtimeUrl,scope),workRoot=await mkdtemp(join(tmpdir(),'mimir-i12-work-'));
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
  async function tx(who,accountId,fields){
    const body={accountId,occurredOn:fields.date,direction:fields.direction??'SAIDA',amountCents:fields.amount??10000,description:fields.description??'Synthetic I13',
      category:fields.category??'GERAL',classification:fields.classification??'DESPESA',isPfBusinessExpense:fields.business??false,explanation:fields.explanation??'',expectedRevision:await revision(who)};
    const r=await fetch(base+'/api/v1/transactions',{method:'POST',headers:json(who),body:JSON.stringify(body)});assert.equal(r.status,201);
    return (await r.json()).transaction.transactionId;
  }
  async function upload(who,id,label='doc'){
    const body=new FormData();body.append('file',new Blob([Buffer.from(`%PDF-1.7\nSynthetic I13 ${label}\n%%EOF\n`)],{type:'application/pdf'}),`${label}.pdf`);
    body.append('expectedRevision',String(await revision(who)));
    return fetch(base+`/api/v1/transactions/${id}/documents`,{method:'POST',headers:headers(who),body});
  }
  const patch=async(who,id,changes,rev)=>fetch(base+`/api/v1/transactions/${id}`,{method:'PATCH',headers:json(who),body:JSON.stringify({...changes,expectedRevision:rev??await revision(who)})});
  const del=async(who,id,rev)=>fetch(base+`/api/v1/transactions/${id}`,{method:'DELETE',headers:json(who),body:JSON.stringify({expectedRevision:rev??await revision(who)})});
  const readPreview=async(who,month)=>{const r=await fetch(base+`/api/v1/periods/${month}/preview`,{headers:headers(who)});assert.equal(r.status,200);return r.json();};
  const pendings=async id=>Object.fromEntries((await admin.query('SELECT type,status,justification FROM mimir.pending_items WHERE transaction_id=$1',[id])).rows.map(r=>[r.type,[r.status,r.justification]]));
  const code=async(r,status,expected)=>{assert.equal(r.status,status);if(expected)assert.equal((await r.json()).code,expected);};

  const a=await owner('Synthetic I13 A'),b=await owner('Synthetic I13 B');
  const pfA=await account(a,'PF'),pjA=await account(a,'PJ'),pj2A=await account(a,'PJ'),pjB=await account(b,'PJ');


  const rows=async(id)=>(await admin.query('SELECT id,type,status,description,justification FROM mimir.pending_items WHERE transaction_id=$1 ORDER BY type',[id])).rows;
  const row=async(id,type)=>(await rows(id)).find(r=>r.type===type);
  const ask=async(who,id,description,rev)=>fetch(base+`/api/v1/transactions/${id}/questions`,{method:'POST',headers:json(who),body:JSON.stringify({description,expectedRevision:rev??await revision(who)})});
  const act=async(who,pid,body,rev)=>fetch(base+`/api/v1/pending-items/${pid}`,{method:'PATCH',headers:json(who),body:JSON.stringify({...body,expectedRevision:rev??await revision(who)})});
  const listing=async(who,query)=>fetch(base+`/api/v1/pending-items?${query}`,{headers:headers(who)});
  const unchanged=async(who,work)=>{const before=await revision(who);await work();assert.equal(await revision(who),before);};

  await t.test('migration 009: runtime edits only description, trigger guards automatic text and identity',async()=>{
    assert.equal(await persistence.ready(),true);
    assert.equal((await admin.query("SELECT count(*)::int n FROM mimir.schema_migrations WHERE version='009_pending_description.sql'")).rows[0].n,1);
    const id=await tx(a,pjA,{date:'2026-10-05'});
    const doc=await row(id,'DOCUMENTO_AUSENTE');assert.ok(doc);
    assert.equal((await ask(a,id,'Dúvida sobre a nota')).status,201);
    const question=await row(id,'DUVIDA_CADASTRADA');
    const runtime=new pg.Client({connectionString:runtimeUrl});await runtime.connect();
    try{
      await assert.rejects(runtime.query("UPDATE mimir.pending_items SET description='alterada' WHERE id=$1",[doc.id]),e=>e.code==='23514');
      await assert.rejects(runtime.query("UPDATE mimir.pending_items SET type='DUVIDA_CADASTRADA' WHERE id=$1",[doc.id]),e=>e.code==='42501');
      await assert.rejects(runtime.query("UPDATE mimir.pending_items SET transaction_id=$2 WHERE id=$1",[question.id,id]),e=>e.code==='42501');
      await assert.rejects(runtime.query("DELETE FROM mimir.pending_items WHERE id=$1",[question.id]),e=>e.code==='42501');
      assert.equal((await runtime.query("UPDATE mimir.pending_items SET description='Dúvida editada' WHERE id=$1",[question.id])).rowCount,1);
    }finally{await runtime.end();}
    await assert.rejects(admin.query("UPDATE mimir.pending_items SET type='DOCUMENTO_AUSENTE' WHERE id=$1",[question.id]),e=>e.code==='23514');
    const second=await tx(a,pjA,{date:'2026-10-05'});
    for(const [sql,params] of [['transaction_id=$2',[question.id,second]],['id=gen_random_uuid()',[question.id]],['workspace_id=$2',[question.id,b.workspaceId]]])
      await assert.rejects(admin.query(`UPDATE mimir.pending_items SET ${sql} WHERE id=$1`,params),e=>e.code==='23514');
    await assert.rejects(admin.query("UPDATE mimir.pending_items SET created_at=now()-interval '1 day' WHERE id=$1",[question.id]),e=>e.code==='23514');
  });

  await t.test('JUSTIFY: automatic and manual items, one revision per effective change, text normalized',async()=>{
    const id=await tx(a,pjA,{date:'2026-10-06'});const doc=await row(id,'DOCUMENTO_AUSENTE');const rev=await revision(a);
    const r=await act(a,doc.id,{action:'JUSTIFY',justification:'  Comprovante\r\nnão existe  '},rev);assert.equal(r.status,200);const body=await r.json();
    assert.equal(body.revision,rev+1);assert.equal(await revision(a),rev+1);
    assert.deepEqual(body.pendingItem,{pendingId:doc.id,transactionId:id,pendingType:'DOCUMENTO_AUSENTE',status:'JUSTIFICADA',description:doc.description,justification:'Comprovante\nnão existe'});
    const same=await act(a,doc.id,{action:'JUSTIFY',justification:'Comprovante\nnão existe'});assert.equal(same.status,200);assert.equal((await same.json()).revision,rev+1);assert.equal(await revision(a),rev+1);
    const other=await act(a,doc.id,{action:'JUSTIFY',justification:'Outro motivo'});assert.equal(other.status,200);assert.equal(await revision(a),rev+2);
    assert.equal((await row(id,'DOCUMENTO_AUSENTE')).justification,'Outro motivo');
    assert.equal((await ask(a,id,'Qual é a categoria?')).status,201);const question=await row(id,'DUVIDA_CADASTRADA');
    assert.equal((await act(a,question.id,{action:'JUSTIFY',justification:'Aguardando contador'})).status,200);
    assert.equal((await row(id,'DUVIDA_CADASTRADA')).status,'JUSTIFICADA');
  });

  await t.test('JUSTIFY rejections leave revision and rows untouched',async()=>{
    const id=await tx(a,pjA,{date:'2026-10-07'}),foreign=await tx(b,pjB,{date:'2026-10-07'});
    const doc=await row(id,'DOCUMENTO_AUSENTE'),foreignDoc=await row(foreign,'DOCUMENTO_AUSENTE');const rev=await revision(a);
    await code(await act(a,doc.id,{action:'JUSTIFY',justification:'ok ok'},rev-1),409,'REVISION_CONFLICT');
    await code(await act(a,doc.id,{action:'JUSTIFY',justification:'ab'},rev),422,'INVALID_INPUT');
    await code(await act(a,doc.id,{action:'JUSTIFY',justification:'a'.repeat(2001)},rev),422,'INVALID_INPUT');
    await code(await act(a,doc.id,{action:'JUSTIFY',justification:'   ab   '},rev),422,'INVALID_INPUT');
    await code(await act(a,doc.id,{action:'JUSTIFY',justification:'motivo',extra:1},rev),422,'INVALID_INPUT');
    await code(await act(a,'not-a-uuid',{action:'JUSTIFY',justification:'motivo'},rev),422,'INVALID_ID');
    await code(await act(a,randomUUID(),{action:'JUSTIFY',justification:'motivo'},rev),404,'NOT_FOUND');
    await code(await act(a,foreignDoc.id,{action:'JUSTIFY',justification:'motivo'},rev),404,'NOT_FOUND');
    await code(await act(b,doc.id,{action:'JUSTIFY',justification:'motivo'}),404,'NOT_FOUND');
    await code(await fetch(base+`/api/v1/pending-items/${doc.id}`,{method:'PATCH',headers:{...json(a),'X-CSRF-Token':'0'.repeat(64)},body:JSON.stringify({action:'JUSTIFY',justification:'motivo',expectedRevision:rev})}),403);
    await code(await fetch(base+`/api/v1/pending-items/${doc.id}`,{method:'PATCH',headers:{...json(a),Origin:'http://evil.invalid'},body:JSON.stringify({action:'JUSTIFY',justification:'motivo',expectedRevision:rev})}),403);
    await code(await fetch(base+`/api/v1/pending-items/${doc.id}?x=1`,{method:'PATCH',headers:json(a),body:JSON.stringify({action:'JUSTIFY',justification:'motivo',expectedRevision:rev})}),400,'INVALID_QUERY');
    assert.equal(await revision(a),rev);assert.equal((await row(id,'DOCUMENTO_AUSENTE')).status,'PENDENTE');assert.equal((await row(foreign,'DOCUMENTO_AUSENTE')).status,'PENDENTE');
    await code(await fetch(base+`/api/v1/pending-items/${doc.id}`,{method:'PUT',headers:json(a),body:'{}'}),405);
  });

  await t.test('resolved automatic item cannot be justified; other manual actions are refused for automatic items',async()=>{
    const id=await tx(a,pjA,{date:'2026-10-08'});const doc=await row(id,'DOCUMENTO_AUSENTE');
    assert.equal((await upload(a,id,'resolve')).status,201);assert.equal((await row(id,'DOCUMENTO_AUSENTE')).status,'RESOLVIDA');
    await unchanged(a,async()=>{
      await code(await act(a,doc.id,{action:'JUSTIFY',justification:'motivo'}),409,'PENDING_RESOLVED');
      await code(await act(a,doc.id,{action:'RESOLVE'}),409,'PENDING_AUTOMATIC');
      await code(await act(a,doc.id,{action:'REOPEN'}),409,'PENDING_AUTOMATIC');
      await code(await act(a,doc.id,{action:'EDIT',description:'novo texto'}),409,'PENDING_AUTOMATIC');
    });
    const open=await tx(a,pjA,{date:'2026-10-08'});const pending=await row(open,'DOCUMENTO_AUSENTE');
    await unchanged(a,async()=>{
      await code(await act(a,pending.id,{action:'RESOLVE'}),409,'PENDING_AUTOMATIC');
      await code(await act(a,pending.id,{action:'REOPEN'}),409,'PENDING_AUTOMATIC');
      await code(await act(a,pending.id,{action:'EDIT',description:'novo texto'}),409,'PENDING_AUTOMATIC');
    });
    assert.equal((await act(a,pending.id,{action:'JUSTIFY',justification:'sem comprovante'})).status,200);
    assert.equal((await upload(a,open,'cause')).status,201);
    assert.equal((await row(open,'DOCUMENTO_AUSENTE')).status,'RESOLVIDA');
    assert.equal((await row(open,'DOCUMENTO_AUSENTE')).description,doc.description);
  });

  await t.test('question: register once per transaction, then edit, justify, resolve and reopen',async()=>{
    const id=await tx(a,pjA,{date:'2026-10-09'});const rev=await revision(a);
    const r=await ask(a,id,'  Esta despesa é dedutível?  ',rev);assert.equal(r.status,201);const body=await r.json();
    assert.equal(body.revision,rev+1);assert.equal(await revision(a),rev+1);
    assert.deepEqual(body.pendingItem,{pendingId:body.pendingItem.pendingId,transactionId:id,pendingType:'DUVIDA_CADASTRADA',status:'PENDENTE',description:'Esta despesa é dedutível?',justification:''});
    const pid=body.pendingItem.pendingId;
    await unchanged(a,async()=>{await code(await ask(a,id,'Outra dúvida'),409,'QUESTION_ALREADY_EXISTS');});
    let step=await act(a,pid,{action:'EDIT',description:'Dúvida reescrita'});assert.equal(step.status,200);assert.equal((await step.json()).pendingItem.description,'Dúvida reescrita');
    await unchanged(a,async()=>{assert.equal((await act(a,pid,{action:'EDIT',description:'Dúvida reescrita'})).status,200);assert.equal((await act(a,pid,{action:'REOPEN'})).status,200);});
    step=await act(a,pid,{action:'JUSTIFY',justification:'Perguntei ao contador'});assert.equal((await step.json()).pendingItem.status,'JUSTIFICADA');
    step=await act(a,pid,{action:'EDIT',description:'Dúvida revisada'});const edited=(await step.json()).pendingItem;
    assert.deepEqual([edited.status,edited.justification,edited.description],['JUSTIFICADA','Perguntei ao contador','Dúvida revisada']);
    step=await act(a,pid,{action:'RESOLVE'});assert.equal((await step.json()).pendingItem.status,'RESOLVIDA');
    await unchanged(a,async()=>{
      assert.equal((await act(a,pid,{action:'RESOLVE'})).status,200);
      await code(await act(a,pid,{action:'EDIT',description:'tarde demais'}),409,'PENDING_RESOLVED');
      await code(await act(a,pid,{action:'JUSTIFY',justification:'tarde demais'}),409,'PENDING_RESOLVED');
      await code(await ask(a,id,'Nova dúvida'),409,'QUESTION_ALREADY_EXISTS');
    });
    step=await act(a,pid,{action:'REOPEN'});const reopened=(await step.json()).pendingItem;
    assert.deepEqual([reopened.status,reopened.justification],['PENDENTE','']);
  });

  await t.test('question rejections: stale revision, short text, foreign or deleted transaction, bad input',async()=>{
    const id=await tx(a,pjA,{date:'2026-10-10'}),gone=await tx(a,pjA,{date:'2026-10-10'}),foreign=await tx(b,pjB,{date:'2026-10-10'});
    assert.equal((await del(a,gone)).status,200);const rev=await revision(a);
    await code(await ask(a,id,'Dúvida válida',rev-1),409,'REVISION_CONFLICT');
    await code(await ask(a,id,'ab',rev),422,'INVALID_INPUT');
    await code(await ask(a,id,'a'.repeat(2001),rev),422,'INVALID_INPUT');
    await code(await ask(a,foreign,'Dúvida válida',rev),404,'NOT_FOUND');
    await code(await ask(b,id,'Dúvida válida'),404,'NOT_FOUND');
    await code(await ask(a,randomUUID(),'Dúvida válida',rev),404,'NOT_FOUND');
    await code(await ask(a,'not-a-uuid','Dúvida válida',rev),422,'INVALID_ID');
    await code(await ask(a,gone,'Dúvida válida',rev),409,'TRANSACTION_INACTIVE');
    await code(await fetch(base+`/api/v1/transactions/${id}/questions`,{method:'POST',headers:json(a),body:JSON.stringify({description:'Dúvida válida',expectedRevision:rev,justification:'x'})}),422,'INVALID_INPUT');
    await code(await fetch(base+`/api/v1/transactions/${id}/questions`,{method:'POST',headers:{...json(a),'X-CSRF-Token':'0'.repeat(64)},body:JSON.stringify({description:'Dúvida válida',expectedRevision:rev})}),403);
    await code(await fetch(base+`/api/v1/transactions/${id}/questions`,{method:'GET',headers:headers(a)}),405);
    assert.equal(await revision(a),rev);assert.equal((await row(id,'DUVIDA_CADASTRADA')),undefined);assert.equal((await row(gone,'DUVIDA_CADASTRADA')),undefined);
  });

  await t.test('pending of a deleted transaction is refused and hidden from the listing',async()=>{
    const id=await tx(a,pjA,{date:'2026-12-01'});const doc=await row(id,'DOCUMENTO_AUSENTE');
    assert.equal((await ask(a,id,'Dúvida a esconder')).status,201);const question=await row(id,'DUVIDA_CADASTRADA');
    assert.equal((await del(a,id)).status,200);
    await unchanged(a,async()=>{
      await code(await act(a,doc.id,{action:'JUSTIFY',justification:'motivo'}),409,'TRANSACTION_INACTIVE');
      await code(await act(a,question.id,{action:'RESOLVE'}),409,'TRANSACTION_INACTIVE');
    });
    const page=await (await listing(a,'periodMonth=2026-12')).json();assert.deepEqual(page.items,[]);
  });

  await t.test('automatic reconciliation never touches a manual question',async()=>{
    const id=await tx(a,pjA,{date:'2026-10-11'});assert.equal((await ask(a,id,'Dúvida persistente')).status,201);
    const question=await row(id,'DUVIDA_CADASTRADA');assert.equal((await act(a,question.id,{action:'JUSTIFY',justification:'motivo da dúvida'})).status,200);
    assert.equal((await upload(a,id,'cause')).status,201);
    assert.equal((await patch(a,id,{amountCents:777,classification:'A_ESCLARECER',explanation:'mudou'})).status,200);
    assert.equal((await patch(a,id,{classification:'DESPESA'})).status,200);
    const current=await row(id,'DUVIDA_CADASTRADA');assert.deepEqual([current.id,current.status,current.justification,current.description],[question.id,'JUSTIFICADA','motivo da dúvida','Dúvida persistente']);
    assert.equal((await row(id,'DOCUMENTO_AUSENTE')).status,'RESOLVIDA');
  });

  await t.test('automatic item justified then reopened by a material change drops the justification',async()=>{
    const id=await tx(a,pjA,{date:'2026-10-12'});const doc=await row(id,'DOCUMENTO_AUSENTE');
    assert.equal((await act(a,doc.id,{action:'JUSTIFY',justification:'sem comprovante'})).status,200);
    assert.equal((await patch(a,id,{explanation:'só texto'})).status,200);assert.equal((await row(id,'DOCUMENTO_AUSENTE')).status,'JUSTIFICADA');
    assert.equal((await patch(a,id,{amountCents:20000})).status,200);
    const after=await row(id,'DOCUMENTO_AUSENTE');assert.deepEqual([after.status,after.justification],['PENDENTE','']);
  });

  await t.test('listing: ordered by type then id, cursor pages without repetition, deleted and foreign items hidden',async()=>{
    const c=await owner('Synthetic I13 C'),pj=await account(c,'PJ'),pf=await account(c,'PF');
    const one=await tx(c,pj,{date:'2026-08-03'}),two=await tx(c,pf,{date:'2026-08-04',classification:'A_ESCLARECER',category:'GERAL'});await tx(c,pf,{date:"2026-08-05",business:true});
    assert.equal((await ask(c,one,'Dúvida um')).status,201);assert.equal((await ask(c,two,'Dúvida dois')).status,201);
    const hidden=await tx(c,pj,{date:'2026-08-06'});const other=await tx(c,pj,{date:'2026-09-06'});
    assert.equal((await del(c,hidden)).status,200);
    const expected=(await admin.query(`SELECT p.id,p.type FROM mimir.pending_items p JOIN mimir.transactions t ON (t.workspace_id,t.id)=(p.workspace_id,p.transaction_id)
      WHERE p.workspace_id=$1 AND t.period_month='2026-08' AND t.status='ATIVA' ORDER BY p.type COLLATE "C",p.id`,[c.workspaceId])).rows;
    assert.equal(expected.length,6);
    assert.deepEqual([...new Set(expected.map(x=>x.type))],['CLASSIFICACAO_A_ESCLARECER','DOCUMENTO_AUSENTE','DUVIDA_CADASTRADA','REEMBOLSO_PF_PENDENTE']);
    const seen=[];let cursor=null,pages=0,revisions=new Set();
    do{
      const r=await listing(c,`periodMonth=2026-08&limit=3${cursor?`&cursor=${cursor}`:''}`);assert.equal(r.status,200);const body=await r.json();
      assert.deepEqual(Object.keys(body).sort(),['items','nextCursor','revision']);revisions.add(body.revision);
      for(const entry of body.items){assert.deepEqual(Object.keys(entry).sort(),['description','justification','pendingId','pendingType','status','transactionId']);seen.push([entry.pendingId,entry.pendingType]);}
      cursor=body.nextCursor;pages++;assert.ok(pages<=3);
    }while(cursor);
    assert.equal(pages,2);assert.deepEqual(seen,expected.map(x=>[x.id,x.type]));assert.equal(revisions.size,1);
    const hiddenIds=(await rows(hidden)).map(r=>r.id);assert.equal(hiddenIds.length,1);assert.ok(!seen.some(([id])=>hiddenIds.includes(id)));
    const sep=await (await listing(c,'periodMonth=2026-09')).json();assert.deepEqual(sep.items.map(x=>x.transactionId),[other]);
    const empty=await (await listing(a,'periodMonth=2025-01')).json();assert.deepEqual(empty.items,[]);
    const foreignView=await (await listing(b,'periodMonth=2026-08')).json();assert.deepEqual(foreignView.items,[]);
    const midCursor=`${seen[0][1]}_${seen[0][0]}`;
    const leak=await (await listing(b,`periodMonth=2026-08&cursor=${midCursor}`)).json();assert.deepEqual(leak.items,[]);
    const before=await revision(c);await listing(c,'periodMonth=2026-08');assert.equal(await revision(c),before);
    for(const q of ['','limit=5','periodMonth=2026-08&limit=0','periodMonth=2026-08&limit=201','periodMonth=2026-08&cursor=ZZ_x','periodMonth=2026-08&x=1'])await code(await listing(c,q),400);
    await code(await listing(c,'periodMonth=2026-13'),422,'INVALID_MONTH');
    await code(await fetch(base+'/api/v1/pending-items?periodMonth=2026-08'),401);
  });

  await t.test('concurrent mutations with the same revision: exactly one wins',async()=>{
    const id=await tx(a,pjA,{date:'2026-10-13'});assert.equal((await ask(a,id,'Disputa de revisão')).status,201);
    const question=await row(id,'DUVIDA_CADASTRADA'),doc=await row(id,'DOCUMENTO_AUSENTE');const rev=await revision(a);
    const results=await Promise.all([act(a,question.id,{action:'JUSTIFY',justification:'primeiro motivo'},rev),act(a,doc.id,{action:'JUSTIFY',justification:'segundo motivo'},rev),act(a,question.id,{action:'RESOLVE'},rev)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409,409]);
    for(const lost of results.filter(r=>r.status===409))assert.equal((await lost.json()).code,'REVISION_CONFLICT');assert.equal(await revision(a),rev+1);
  });

  await t.test('preview counts and a new capture reflect pending changes; earlier delivery stays identical',async()=>{
    const d=await owner('Synthetic I13 D'),pj=await account(d,'PJ');
    const id=await tx(d,pj,{date:'2026-07-05',amount:1000});
    const worker=new DeliveryExecutor(executorPort,{workRoot,pollMs:50,renewMs:50});
    async function capture(reason=''){
      const r=await fetch(base+'/api/v1/deliveries',{method:'POST',headers:{...json(d),'Idempotency-Key':randomUUID()},body:JSON.stringify({periodMonth:'2026-07',expectedRevision:await revision(d),rectificationReason:reason})});
      assert.equal(r.status,202);const op=await r.json();
      for(let i=0;i<80;i++){const s=await (await fetch(base+`/api/v1/operations/${op.id}`,{headers:headers(d)})).json();if(s.status==='PRONTA')return op;assert.notEqual(s.status,'FALHA');await worker.tick();await sleep(60);}
      assert.fail('delivery not ready');
    }
    const download=async(op,kind)=>Buffer.from(await (await fetch(base+`/api/v1/deliveries/${op.snapshotId}/${kind}`,{headers:headers(d)})).arrayBuffer());
    const before=await readPreview(d,'2026-07');assert.deepEqual([before.summary.pendingCount,before.summary.justifiedCount],[1,0]);
    const v1=await capture(),v1Zip=await download(v1,'package'),v1Manifest=await download(v1,'manifest');
    assert.equal((await ask(d,id,'Dúvida do mês')).status,201);
    const doc=await row(id,'DOCUMENTO_AUSENTE'),question=await row(id,'DUVIDA_CADASTRADA');
    const withQuestion=await readPreview(d,'2026-07');assert.deepEqual([withQuestion.summary.pendingCount,withQuestion.summary.justifiedCount],[2,0]);
    assert.equal((await act(d,doc.id,{action:'JUSTIFY',justification:'Sem comprovante disponível'})).status,200);
    assert.equal((await act(d,question.id,{action:'RESOLVE'})).status,200);
    const after=await readPreview(d,'2026-07');assert.deepEqual([after.summary.pendingCount,after.summary.justifiedCount],[0,1]);
    assert.ok((await download(v1,'package')).equals(v1Zip));assert.ok((await download(v1,'manifest')).equals(v1Manifest));
    const v2=await capture('Pendências justificadas'),manifest=JSON.parse((await download(v2,'manifest')).toString('utf8'));
    const items=manifest.pendingItems.map(x=>[x.pendingType,x.status,x.justification]).sort((x,y)=>x[0].localeCompare(y[0]));
    assert.deepEqual(items,[['DOCUMENTO_AUSENTE','JUSTIFICADA','Sem comprovante disponível'],['DUVIDA_CADASTRADA','RESOLVIDA','']]);
    const root=await mkdtemp(join(tmpdir(),'mimir-i13-verify-'));
    try{
      for(const [name,data] of readZip(await download(v2,'package'))){const dest=join(root,'pkg',name);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,data);}
      await writeFile(join(root,'ref.json'),await download(v2,'manifest'));
      const verified=await verifyDeliveryPackage(join(root,'pkg'),join(root,'ref.json'));assert.equal(verified.ok,true,verified.message);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
