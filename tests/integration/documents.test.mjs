import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {request} from 'node:http';
import pg from 'pg';
import {createOwner} from '../../tools/admin/owners.mjs';
import {PostgresAuthentication} from '../../apps/api/dist/adapters/postgres-auth.js';
import {PostgresPersistence} from '../../apps/api/dist/adapters/postgres.js';
import {PostgresAccounts} from '../../apps/api/dist/adapters/postgres-accounts.js';
import {PostgresTransactions} from '../../apps/api/dist/adapters/postgres-transactions.js';
import {AuthenticationService,sessionHash} from '../../apps/api/dist/auth/service.js';
import {createApp} from '../../apps/api/dist/server.js';

test('I05 immutable upload: PostgreSQL and HTTP real',async t=>{
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  const url=new URL(process.env.MIGRATION_DATABASE_URL);url.username='mimir_runtime';url.password=process.env.APP_ROLE_PASSWORD;
  const auth=new PostgresAuthentication(url.toString()),persistence=new PostgresPersistence(url.toString()),accounts=new PostgresAccounts(url.toString()),transactions=new PostgresTransactions(url.toString());
  const module=await import('../../apps/api/dist/adapters/postgres-documents.js').catch(()=>null),documents=module?new module.PostgresDocuments(url.toString()):undefined;
  const service=await AuthenticationService.create(auth),logs=[],origin='http://127.0.0.1:3000';
  const server=createApp(persistence,fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),{service,origins:new Set([origin]),allowLocalHttp:true,log:event=>logs.push(event)},accounts,transactions,documents);
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await Promise.all([auth.close(),persistence.close(),accounts.close(),transactions.close(),documents?.close(),admin.end()]);});
  const password=randomBytes(24).toString('hex'),pdf=Buffer.from('%PDF-1.7\nSynthetic I05\n%%EOF\n');
  async function owner(){
    const email=`${randomUUID()}@example.invalid`,identity=await createOwner({email,password,displayName:'Synthetic I05',companyName:'Synthetic I05'});
    const r=await fetch(base+'/api/v1/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);
    return{...identity,token:r.headers.get('set-cookie').match(/^mimir_session=([a-f0-9]{64});/)[1],csrf:(await r.json()).csrfToken};
  }
  const a=await owner(),b=await owner();
  const headers=(who=a)=>({Origin:origin,Cookie:`mimir_session=${who.token}`,'X-CSRF-Token':who.csrf});
  const revision=async(who=a)=>Number((await admin.query('SELECT revision::text n FROM mimir.workspaces WHERE id=$1',[who.workspaceId])).rows[0].n);
  async function transaction(who=a,classification='DESPESA',business=false){
    let r=await fetch(base+'/api/v1/accounts',{method:'POST',headers:{...headers(who),'Content-Type':'application/json'},body:JSON.stringify({name:randomUUID(),accountType:'PF',expectedRevision:await revision(who)})});assert.equal(r.status,201);const account=(await r.json()).account;
    r=await fetch(base+'/api/v1/transactions',{method:'POST',headers:{...headers(who),'Content-Type':'application/json'},body:JSON.stringify({accountId:account.id,occurredOn:'2026-11-01',direction:classification==='RECEITA'?'ENTRADA':'SAIDA',amountCents:1250,description:'Synthetic I05',category:'Geral',classification,isPfBusinessExpense:business,explanation:'',expectedRevision:await revision(who)})});assert.equal(r.status,201);return(await r.json()).transaction.transactionId;
  }
  function form(rev,bytes=pdf,name='café.pdf',mime='application/pdf'){
    const body=new FormData();body.append('file',new Blob([bytes],{type:mime}),name);body.append('expectedRevision',String(rev));return body;
  }
  const upload=(id,body,who=a,extra={})=>fetch(base+`/api/v1/transactions/${id}/documents`,{method:'POST',headers:{...headers(who),...extra},body});
  const counts=async(who=a)=>(await admin.query(`SELECT (SELECT count(*)::int FROM mimir.documents WHERE workspace_id=$1) documents,(SELECT count(*)::int FROM mimir.transaction_documents WHERE workspace_id=$1) links`,[who.workspaceId])).rows[0];
  const pending=async(id,who=a)=>(await admin.query('SELECT type,status,justification FROM mimir.pending_items WHERE workspace_id=$1 AND transaction_id=$2 ORDER BY type',[who.workspaceId,id])).rows;
  const tx=await transaction(a,'DESPESA',true),foreign=await transaction(b);let docId;
  await t.test('POST returns exact DTO and stores immutable bytes/hash/link, resolves only documentary cause',async()=>{
    const before=await revision(),r=await upload(tx,form(before));assert.equal(r.status,201);const body=await r.json();docId=body.documentId;
    assert.deepEqual(body,{documentId:docId,transactionId:tx,sha256:createHash('sha256').update(pdf).digest('hex'),sizeBytes:pdf.length,revision:before+1});assert.match(docId,/^[a-f0-9-]{36}$/);
    const row=(await admin.query('SELECT original_name,mime,size_bytes,hash,bytes,supersedes_document_id FROM mimir.documents WHERE workspace_id=$1 AND id=$2',[a.workspaceId,docId])).rows[0];
    assert.deepEqual(row,{original_name:'café.pdf',mime:'application/pdf',size_bytes:pdf.length,hash:body.sha256,bytes:pdf,supersedes_document_id:null});
    assert.equal((await admin.query('SELECT count(*)::int n FROM mimir.transaction_documents WHERE workspace_id=$1 AND transaction_id=$2 AND document_id=$3',[a.workspaceId,tx,docId])).rows[0].n,1);
    assert.deepEqual(await pending(tx),[{type:'DOCUMENTO_AUSENTE',status:'RESOLVIDA',justification:''},{type:'REEMBOLSO_PF_PENDENTE',status:'PENDENTE',justification:''}]);
  });
  await t.test('PNG JPEG and exact 5 MiB accepted; same hash new upload has independent identity',async()=>{
    for(const [name,mime,bytes] of [['a.png','image/png',Buffer.from('89504e470d0a1a0a','hex')],['a.jpeg','image/jpeg',Buffer.from('ffd8ffe0','hex')],['a.PDF','application/pdf',Buffer.alloc(5242880)]]){
      if(name==='a.PDF')pdf.copy(bytes);const r=await upload(tx,form(await revision(),bytes,name,mime));assert.equal(r.status,201);const body=await r.json();assert.equal(body.sizeBytes,bytes.length);assert.equal(body.sha256,createHash('sha256').update(bytes).digest('hex'));
    }
    const r=await upload(tx,form(await revision()));assert.equal(r.status,201);assert.notEqual((await r.json()).documentId,docId);
  });
  await t.test('material documentary link reopens justified automatic causes, preserves manual question and resolves missing-document',async()=>{
    await admin.query("UPDATE mimir.pending_items SET status='JUSTIFICADA',justification='Synthetic justification' WHERE workspace_id=$1 AND transaction_id=$2",[a.workspaceId,tx]);
    await admin.query("INSERT INTO mimir.pending_items(id,workspace_id,transaction_id,type,status,description,justification) VALUES($1,$2,$3,'DUVIDA_CADASTRADA','JUSTIFICADA','Synthetic question','Synthetic answer')",[randomUUID(),a.workspaceId,tx]);
    assert.equal((await upload(tx,form(await revision()))).status,201);
    assert.deepEqual(await pending(tx),[{type:'DOCUMENTO_AUSENTE',status:'RESOLVIDA',justification:'Synthetic justification'},{type:'DUVIDA_CADASTRADA',status:'JUSTIFICADA',justification:'Synthetic answer'},{type:'REEMBOLSO_PF_PENDENTE',status:'PENDENTE',justification:''}]);
    const unclear=await transaction(a,'A_ESCLARECER');await admin.query("UPDATE mimir.pending_items SET status='JUSTIFICADA',justification='Synthetic explanation' WHERE workspace_id=$1 AND transaction_id=$2",[a.workspaceId,unclear]);
    assert.equal((await upload(unclear,form(await revision()))).status,201);assert.deepEqual(await pending(unclear),[{type:'CLASSIFICACAO_A_ESCLARECER',status:'PENDENTE',justification:''}]);
    const transfer=await transaction(a,'TRANSFERENCIA');assert.equal((await upload(transfer,form(await revision()))).status,201);assert.deepEqual(await pending(transfer),[]);
  });
  await t.test('invalid multipart metadata MIME signature size and query do not write',async()=>{
    const before=await counts(),rev=await revision();
    for(const [body,status] of [[form(rev,Buffer.alloc(0)),422],[form(rev,Buffer.alloc(5242881)),413],[form(rev,pdf,'a.txt'),415],[form(rev,pdf,'a.png','image/png'),422],[form(rev,pdf,'a.pdf','image/jpeg'),415],[form('1e2'),422],[form('9007199254740992'),422]])assert.equal((await upload(tx,body)).status,status);
    for(const field of ['file','expectedRevision','extra']){const body=form(rev);body.append(field,'untrusted');assert.equal((await upload(tx,body)).status,422);}
    const textFile=new FormData();textFile.append('file','text');textFile.append('expectedRevision',String(rev));assert.equal((await upload(tx,textFile)).status,422);
    const fileRevision=form(rev);fileRevision.set('expectedRevision',new Blob(['1']),'revision.txt');assert.equal((await upload(tx,fileRevision)).status,422);
    assert.equal((await upload(tx,'malformed',a,{'Content-Type':'multipart/form-data; boundary=missing'})).status,400);
    assert.equal((await upload(tx,'{}',a,{'Content-Type':'application/json'})).status,415);
    assert.equal((await upload(tx,'x'.repeat(5242880+16385),a,{'Content-Type':'multipart/form-data; boundary=x'})).status,413);
    assert.equal((await fetch(base+`/api/v1/transactions/${tx}/documents?extra=1`,{method:'POST',headers:headers(),body:form(rev)})).status,400);
    assert.equal((await upload('invalid',form(rev))).status,422);assert.deepEqual(await counts(),before);assert.equal(await revision(),rev);
  });
  await t.test('authentication origin CSRF and duplicate cookie are enforced before upload',async()=>{
    const before=await counts(),rev=await revision();
    for(const [extra,status] of [[{Cookie:''},401],[{'X-CSRF-Token':''},403],[{Origin:'http://untrusted.invalid'},403],[{Cookie:`mimir_session=${a.token}; mimir_session=${a.token}`},401]])assert.equal((await upload(tx,form(rev),a,extra)).status,status);
    assert.equal((await fetch(base+`/api/v1/transactions/${tx}/documents`,{headers:{Cookie:`mimir_session=${a.token}`}})).status,405);
    assert.deepEqual(await counts(),before);assert.equal(await revision(),rev);
  });
  await t.test('chunked oversized transport is refused with 413 and no write',async()=>{
    const before=await counts(),rev=await revision();
    const status=await new Promise((resolve,reject)=>{
      const req=request(base+`/api/v1/transactions/${tx}/documents`,{method:'POST',headers:{...headers(),'Content-Type':'multipart/form-data; boundary=x'}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
      req.on('error',reject);req.write('first chunk');req.end(Buffer.alloc(5242880+16384));
    });
    assert.equal(status,413);assert.deepEqual(await counts(),before);assert.equal(await revision(),rev);
  });
  await t.test('foreign missing excluded and stale targets never create orphan bytes',async()=>{
    const before=await counts(),rev=await revision();
    for(const id of [foreign,randomUUID()])assert.equal((await upload(id,form(1))).status,404);
    const excluded=await transaction();await admin.query("UPDATE mimir.transactions SET status='EXCLUIDA' WHERE workspace_id=$1 AND id=$2",[a.workspaceId,excluded]);
    assert.equal((await upload(excluded,form(await revision()))).status,409);assert.equal((await upload(tx,form(rev))).status,409);
    assert.deepEqual(await counts(),before);
  });
  await t.test('concurrent same revision has one commit and one stale rejection',async()=>{
    const before=await counts(),rev=await revision(),rs=await Promise.all([upload(tx,form(rev)),upload(tx,form(rev))]);assert.deepEqual(rs.map(r=>r.status).sort(),[201,409]);assert.deepEqual(await counts(),{documents:before.documents+1,links:before.links+1});assert.equal(await revision(),rev+1);
  });
  await t.test('two admitted uploads include database wait; third is bounded with 429 and reservations release',async()=>{
    const actor=await owner(),id=await transaction(actor),rev=await revision(actor),supervisor=new pg.Client({connectionString:process.env.PROVISION_DATABASE_URL});await supervisor.connect();
    await admin.query('BEGIN');let responses=[];
    try{
      await admin.query('SELECT id FROM mimir.workspaces WHERE id=$1 FOR UPDATE',[actor.workspaceId]);responses=[upload(id,form(rev),actor),upload(id,form(rev),actor)];
      const until=Date.now()+1200;let waiting=0;
      while(Date.now()<until){waiting=(await supervisor.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='mimir-documents' AND wait_event_type='Lock'")).rows[0].n;if(waiting===2)break;await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,2);
      const excess=await upload(id,form(rev),actor);assert.equal(excess.status,429);assert.equal(excess.headers.get('retry-after'),'1');
      await admin.query('COMMIT');assert.deepEqual((await Promise.all(responses)).map(r=>r.status).sort(),[201,409]);
      assert.deepEqual(await counts(actor),{documents:1,links:1});assert.equal(await revision(actor),rev+1);
      assert.equal((await upload(id,form(rev+1),actor)).status,201);
    }finally{await admin.query('ROLLBACK');await Promise.all(responses);await supervisor.end();}
  });
  for(const [table,timing] of [['transaction_documents','INSERT'],['pending_items','UPDATE'],['workspaces','UPDATE']])await t.test(`failure at ${table} rolls back document link reconciliation and revision`,async()=>{
    const id=await transaction(),before=await counts(),rev=await revision(),beforePending=await pending(id),suffix=randomBytes(5).toString('hex');
    await admin.query(`CREATE FUNCTION mimir.fail_i05_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.${table==='workspaces'?'id':'workspace_id'}='${a.workspaceId}'::uuid THEN RAISE EXCEPTION 'Synthetic rollback I05'; END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER fail_i05_${suffix} BEFORE ${timing} ON mimir.${table} FOR EACH ROW EXECUTE FUNCTION mimir.fail_i05_${suffix}()`);
    try{const r=await upload(id,form(rev));assert.equal(r.status,500);assert.equal((await r.json()).code,'INTERNAL_ERROR');assert.deepEqual(await counts(),before);assert.deepEqual(await pending(id),beforePending);assert.equal(await revision(),rev);}
    finally{await admin.query(`DROP TRIGGER fail_i05_${suffix} ON mimir.${table}`);await admin.query(`DROP FUNCTION mimir.fail_i05_${suffix}()`);}
  });
  for(const target of ['workspace','transaction'])await t.test(`revocation while waiting for ${target} lock rolls back all writes`,async()=>{
    const actor=await owner(),id=await transaction(actor),rev=await revision(actor),supervisor=new pg.Client({connectionString:process.env.PROVISION_DATABASE_URL});await supervisor.connect();
    await admin.query('BEGIN');let response;
    try{
      await admin.query(target==='workspace'?'SELECT id FROM mimir.workspaces WHERE id=$1 FOR UPDATE':'SELECT id FROM mimir.transactions WHERE id=$1 FOR UPDATE',[target==='workspace'?actor.workspaceId:id]);
      response=upload(id,form(rev),actor);
      const until=Date.now()+1200;let waiting=false;
      while(Date.now()<until){waiting=(await supervisor.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='mimir-documents' AND wait_event_type='Lock') waiting")).rows[0].waiting;if(waiting)break;await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);
      await admin.query('UPDATE mimir.sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[sessionHash(actor.token)]);await admin.query('COMMIT');
      assert.equal((await response).status,401);assert.deepEqual(await counts(actor),{documents:0,links:0});assert.equal(await revision(actor),rev);
    }finally{await admin.query('ROLLBACK');if(response)await response;await supervisor.end();}
  });
  await t.test('runtime can only reconcile pending columns and cannot mutate document metadata or bytes',async()=>{
    const runtime=new pg.Client({connectionString:url.toString()});await runtime.connect();
    try{
      for(const sql of ["UPDATE mimir.documents SET original_name='changed'",'DELETE FROM mimir.documents','TRUNCATE mimir.documents',"UPDATE mimir.pending_items SET type='DUVIDA_CADASTRADA'",'DELETE FROM mimir.pending_items','TRUNCATE mimir.pending_items'])await assert.rejects(runtime.query(sql),e=>e.code==='42501');
      const grants=(await admin.query("SELECT column_name FROM information_schema.column_privileges WHERE grantee='mimir_runtime' AND table_schema='mimir' AND table_name='pending_items' AND privilege_type='UPDATE' ORDER BY column_name")).rows.map(r=>r.column_name);assert.deepEqual(grants,['description','justification','status','updated_at']);
      await assert.rejects(runtime.query("UPDATE mimir.pending_items SET description='changed' WHERE type='DOCUMENTO_AUSENTE'"),e=>e.code==='23514');
    }finally{await runtime.end();}
  });
  await t.test('forged actor and exhausted revision are refused without bytes; logs contain only safe metadata',async()=>{
    const before=await counts(),rev=await revision();
    if(documents)await assert.rejects(documents.upload({userId:b.userId,workspaceId:a.workspaceId,tokenHash:sessionHash(b.token)},{originalName:'a.pdf',mime:'application/pdf',bytes:pdf,sizeBytes:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex'),expectedRevision:rev},tx),e=>e.status===401);
    await admin.query('UPDATE mimir.workspaces SET revision=9007199254740991 WHERE id=$1',[a.workspaceId]);assert.equal((await upload(tx,form(Number.MAX_SAFE_INTEGER))).status,409);assert.deepEqual(await counts(),before);
    for(const log of logs)assert.deepEqual(Object.keys(log).sort(),['durationMs','operation','requestId','status']);assert.ok(!JSON.stringify(logs).includes('Synthetic I05'));
  });
});
