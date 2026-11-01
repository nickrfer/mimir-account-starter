import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,rm,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {crc32,inflateRawSync} from 'node:zlib';
import pg from 'pg';
import {createOwner} from '../../tools/admin/owners.mjs';
import {PostgresAuthentication} from '../../apps/api/dist/adapters/postgres-auth.js';
import {PostgresPersistence} from '../../apps/api/dist/adapters/postgres.js';
import {PostgresAccounts} from '../../apps/api/dist/adapters/postgres-accounts.js';
import {PostgresPreview} from '../../apps/api/dist/adapters/postgres-preview.js';
import {PostgresDeliveries} from '../../apps/api/dist/adapters/postgres-deliveries.js';
import {AuthenticationService} from '../../apps/api/dist/auth/service.js';
import {createApp} from '../../apps/api/dist/server.js';
import {verifyDeliveryPackage} from '../../packages/verifier/dist/verifier.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function readZip(bytes){
  const end=bytes.length-22,count=bytes.readUInt16LE(end+10);let at=bytes.readUInt32LE(end+16);const entries=new Map();
  for(let i=0;i<count;i++){
    const method=bytes.readUInt16LE(at+10),crc=bytes.readUInt32LE(at+16),csize=bytes.readUInt32LE(at+20),nameLength=bytes.readUInt16LE(at+28),offset=bytes.readUInt32LE(at+42);
    const name=bytes.subarray(at+46,at+46+nameLength).toString('utf8'),start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28),raw=bytes.subarray(start,start+csize);
    const data=method===8?inflateRawSync(raw):raw;assert.equal(crc32(data),crc);entries.set(name,data);at+=46+nameLength;
  }
  return entries;
}

test('I08 executor: leases, fencing, publication and downloads on real PostgreSQL',async t=>{
  const executorModule=await import('../../apps/api/dist/adapters/postgres-executor.js').catch(()=>null);assert.ok(executorModule,'I08 executor adapter missing');
  const {DeliveryExecutor}=await import('../../apps/api/dist/executor/runner.js');
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  const url=new URL(process.env.MIGRATION_DATABASE_URL);url.username='mimir_runtime';url.password=process.env.APP_ROLE_PASSWORD;
  const auth=new PostgresAuthentication(url.toString()),persistence=new PostgresPersistence(url.toString()),accounts=new PostgresAccounts(url.toString());
  const preview=new PostgresPreview(url.toString()),deliveries=new PostgresDeliveries(url.toString());
  const scope=new Set(),port=new executorModule.PostgresExecutor(url.toString(),scope),otherPort=new executorModule.PostgresExecutor(url.toString(),scope);
  const origin='http://127.0.0.1:3000',password=randomBytes(24).toString('hex'),workRoot=await mkdtemp(join(tmpdir(),'mimir-i08-work-'));
  const service=await AuthenticationService.create(auth);
  const server=createApp(persistence,fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),{service,origins:new Set([origin]),allowLocalHttp:true,log:()=>{}},accounts,undefined,undefined,preview,deliveries);
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await Promise.all([admin.end(),auth.close(),persistence.close(),accounts.close(),preview.close(),deliveries.close(),port.close(),otherPort.close()]);await rm(workRoot,{recursive:true,force:true});});
  async function owner(label){
    const email=`${randomUUID()}@example.invalid`,identity=await createOwner({email,password,displayName:label,companyName:label});scope.add(identity.workspaceId);
    const r=await fetch(base+'/api/v1/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);
    return {...identity,token:r.headers.get('set-cookie').match(/^mimir_session=([a-f0-9]{64});/)[1],csrf:(await r.json()).csrfToken};
  }
  const headers=who=>({Origin:origin,Cookie:`mimir_session=${who.token}`,'X-CSRF-Token':who.csrf});
  const revision=async who=>Number((await admin.query('SELECT revision::text n FROM mimir.workspaces WHERE id=$1',[who.workspaceId])).rows[0].n);
  async function seed(who,month='2026-11'){
    const account=randomUUID(),tx=randomUUID(),doc=randomUUID(),bytes=Buffer.from('%PDF-1.7\nSynthetic I08\n%%EOF\n');
    await admin.query('INSERT INTO mimir.accounts(id,workspace_id,name,name_key,account_type) VALUES($1,$2,$3,$4,$5)',[account,who.workspaceId,'Synthetic PF '+account,'synthetic '+account,'PF']);
    await admin.query('INSERT INTO mimir.periods(id,workspace_id,period_month,notes) VALUES($1,$2,$3,$4) ON CONFLICT (workspace_id,period_month) DO NOTHING',[randomUUID(),who.workspaceId,month,'Synthetic notes']);
    await admin.query(`INSERT INTO mimir.transactions(id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,description,category,classification,is_pf_business_expense,explanation,source_type,source_code,external_id,status)
      VALUES($1,$2,$3,$4,$5,'SAIDA',1250,'Synthetic I08','Geral','DESPESA',true,'','MANUAL','MANUAL',$1::uuid::text,'ATIVA')`,[tx,who.workspaceId,account,month+'-01',month]);
    await admin.query('INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[doc,who.workspaceId,'synthetic.pdf','application/pdf',bytes.length,sha(bytes),bytes]);
    await admin.query('INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id) VALUES($1,$2,$3)',[who.workspaceId,tx,doc]);
    return {tx,doc,bytes};
  }
  async function capture(who,reason='',month='2026-11'){
    const r=await fetch(base+'/api/v1/deliveries',{method:'POST',headers:{...headers(who),'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({periodMonth:month,expectedRevision:await revision(who),rectificationReason:reason})});
    assert.equal(r.status,202);return r.json();
  }
  const operation=async id=>(await admin.query('SELECT status,attempt_count,fencing_token::int token,lease_holder,error_code,next_retry_at FROM mimir.delivery_operations WHERE id=$1',[id])).rows[0];
  const packages=async id=>(await admin.query('SELECT count(*)::int n FROM mimir.delivery_packages WHERE operation_id=$1',[id])).rows[0].n;
  const expire=id=>admin.query("UPDATE mimir.delivery_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
  const executor=(p=port,options={})=>new DeliveryExecutor(p,{workRoot,pollMs:50,renewMs:50,...options});
  async function claimFor(id,holder='h1',via=port){const c=await via.claimNextOperation(holder);if(c&&c.operationId!==id)throw new Error('foreign claim');return c;}

  const a=await owner('Synthetic I08 A'),b=await owner('Synthetic I08 B');
  const seeded=await seed(a);
  let ready;

  await t.test('executor publishes a package built only from the snapshot; downloads are exact and owner scoped',async()=>{
    const op=await capture(a),before=await revision(a);
    const premature=await fetch(base+`/api/v1/deliveries/${op.snapshotId}/package`,{headers:headers(a)});assert.equal(premature.status,409);assert.equal((await premature.json()).code,'DELIVERY_NOT_READY');
    await admin.query('UPDATE mimir.transactions SET amount_cents=9999 WHERE id=$1',[seeded.tx]);
    const worker=executor();
    for(let i=0;i<40&&(await operation(op.id)).status!=='PRONTA';i++){await worker.tick();await sleep(60);}
    const row=await operation(op.id);assert.equal(row.status,'PRONTA');assert.equal(row.attempt_count,1);assert.equal(row.token,1);assert.equal(row.lease_holder,null);assert.equal(row.error_code,null);
    assert.equal(await packages(op.id),1);assert.equal(await revision(a),before);
    const state=await (await fetch(base+`/api/v1/operations/${op.id}`,{headers:headers(a)})).json();assert.equal(state.status,'PRONTA');assert.ok(!('token' in state)&&!('fencingToken' in state)&&!('leaseHolder' in state));
    const zipResponse=await fetch(base+`/api/v1/deliveries/${op.snapshotId}/package`,{headers:headers(a)});assert.equal(zipResponse.status,200);
    assert.equal(zipResponse.headers.get('content-type'),'application/zip');assert.match(zipResponse.headers.get('content-disposition'),/^attachment; filename="entrega-2026-11-v1\.zip"$/);assert.equal(zipResponse.headers.get('x-content-type-options'),'nosniff');
    const zip=Buffer.from(await zipResponse.arrayBuffer()),stored=(await admin.query('SELECT zip_bytes,zip_hash,manifest_bytes,manifest_hash FROM mimir.delivery_packages WHERE operation_id=$1',[op.id])).rows[0];
    assert.ok(zip.equals(stored.zip_bytes));assert.equal(sha(zip),stored.zip_hash);assert.equal(zipResponse.headers.get('x-content-sha256'),stored.zip_hash);
    const manifestResponse=await fetch(base+`/api/v1/deliveries/${op.snapshotId}/manifest`,{headers:headers(a)});assert.equal(manifestResponse.status,200);assert.match(manifestResponse.headers.get('content-type'),/^application\/json/);
    const manifestBytes=Buffer.from(await manifestResponse.arrayBuffer());assert.ok(manifestBytes.equals(stored.manifest_bytes));assert.equal(sha(manifestBytes),stored.manifest_hash);
    const entries=readZip(zip);assert.deepEqual([...entries.keys()].sort(),[`anexos/${seeded.doc}.pdf`,'manifesto.json','movimentacoes.csv','resumo.html']);
    assert.ok(entries.get('manifesto.json').equals(manifestBytes));assert.ok(entries.get(`anexos/${seeded.doc}.pdf`).equals(seeded.bytes));
    const manifest=JSON.parse(manifestBytes.toString('utf8'));assert.equal(manifest.schemaVersion,'mimir.manifest.v2');assert.equal(manifest.transactions[0].amountCents,1250);
    assert.equal(manifest.delivery.snapshotId,op.snapshotId);assert.equal(manifest.delivery.operationId,op.id);
    for(const file of manifest.files){assert.equal(sha(entries.get(file.path)),file.sha256);assert.equal(entries.get(file.path).length,file.sizeBytes);}
    assert.match(entries.get('movimentacoes.csv').toString('utf8'),/,1250,/);
    const verifyRoot=await mkdtemp(join(tmpdir(),'mimir-i09-exec-')),extractedDir=join(verifyRoot,'pkg'),refManifest=join(verifyRoot,'ref.manifesto.json');
    try{
      for(const [name,data] of entries){const dest=join(extractedDir,name);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,data);}
      await writeFile(refManifest,manifestBytes);
      const verified=await verifyDeliveryPackage(extractedDir,refManifest);
      assert.equal(verified.ok,true,verified.message);assert.equal(verified.exitCode,0);assert.equal(verified.code,'VERIFIED');assert.equal(verified.counts?.mainTransactions,1);
    }finally{await rm(verifyRoot,{recursive:true,force:true});}
    for(const kind of ['package','manifest']){
      assert.equal((await fetch(base+`/api/v1/deliveries/${op.snapshotId}/${kind}`,{headers:headers(b)})).status,404);
      assert.equal((await fetch(base+`/api/v1/deliveries/${op.snapshotId}/${kind}`)).status,401);
      assert.equal((await fetch(base+`/api/v1/deliveries/${randomUUID()}/${kind}`,{headers:headers(a)})).status,404);
      assert.equal((await fetch(base+`/api/v1/deliveries/not-a-uuid/${kind}`,{headers:headers(a)})).status,422);
      assert.equal((await fetch(base+`/api/v1/deliveries/${op.snapshotId}/${kind}?x=1`,{headers:headers(a)})).status,400);
      assert.equal((await fetch(base+`/api/v1/deliveries/${op.snapshotId}/${kind}`,{method:'POST',headers:headers(a)})).status,405);
    }
    ready=op;
    assert.deepEqual(await readdir(workRoot),[]);
  });

  await t.test('claim fences by token: lease, renewal, takeover, stale publication and failure are rejected',async()=>{
    const who=await owner('Synthetic I08 fencing'),own=await seed(who);const op=await capture(who);
    const [first,rival]=await Promise.all([claimFor(op.id,'holder-1'),claimFor(op.id,'holder-2',otherPort)]);
    assert.equal([first,rival].filter(Boolean).length,1,'exactly one holder wins the row');
    const mine=first??rival,via=first?port:otherPort,other=first?otherPort:port;
    assert.equal(mine.token,1);assert.equal(await other.claimNextOperation('thief').then(c=>c?.operationId===op.id),false);
    assert.equal(await via.renewLease(mine),true);
    await expire(op.id);
    assert.equal(await via.renewLease(mine),false,'expired lease cannot be renewed');
    assert.equal(await via.handleAttemptFailure(mine,'X'),'LOST');
    const stolen=await claimFor(op.id,'holder-3',other);assert.ok(stolen);assert.equal(stolen.token,2);assert.equal(stolen.attempt,2);
    assert.equal(await via.renewLease(mine),false);assert.equal(await via.handleAttemptFailure(mine,'X'),'LOST');
    await assert.rejects(via.readCapturedDocument(mine,own.doc),e=>e.message==='LEASE_LOST');
    const zip=Buffer.from('stale zip'),manifest=Buffer.from('{}\n');
    assert.equal(await via.publishPackage(mine,{zip,zipHash:sha(zip),manifest,manifestHash:sha(manifest)}),false);
    assert.equal(await packages(op.id),0);
    const row=await operation(op.id);assert.equal(row.status,'EM_PROCESSAMENTO');assert.equal(row.token,2);assert.equal(row.lease_holder,'holder-3');
    assert.equal(await other.publishPackage(stolen,{zip,zipHash:sha(zip),manifest,manifestHash:sha(manifest)}),true);
    assert.equal((await operation(op.id)).status,'PRONTA');assert.equal(await packages(op.id),1);
    assert.equal(await other.publishPackage(stolen,{zip,zipHash:sha(zip),manifest,manifestHash:sha(manifest)}),false);
    assert.equal(await other.renewLease(stolen),false);assert.equal(await other.handleAttemptFailure(stolen,'X'),'LOST');
    assert.equal(await claimFor(op.id,'late'),null);
  });

  await t.test('failures retry after 2 s and 5 s, terminate on attempt 3 and exhausted leases are swept to FALHA',async()=>{
    const who=await owner('Synthetic I08 retry');await seed(who);const op=await capture(who);
    let claim=await claimFor(op.id);assert.equal(claim.attempt,1);
    assert.equal(await port.handleAttemptFailure(claim,'FIRST'),'RESCHEDULED');
    let row=await operation(op.id);assert.equal(row.status,'EM_FILA');assert.equal(row.lease_holder,null);assert.equal(row.error_code,null);
    const delay1=(await admin.query('SELECT extract(epoch FROM next_retry_at-clock_timestamp())::float d FROM mimir.delivery_operations WHERE id=$1',[op.id])).rows[0].d;assert.ok(delay1>0.5&&delay1<=2.01,String(delay1));
    assert.equal(await claimFor(op.id),null,'waits for next_retry_at');
    await sleep(2200);claim=await claimFor(op.id);assert.ok(claim);assert.equal(claim.attempt,2);assert.equal(claim.token,2);
    assert.equal(await port.handleAttemptFailure(claim,'SECOND'),'RESCHEDULED');
    const delay2=(await admin.query('SELECT extract(epoch FROM next_retry_at-clock_timestamp())::float d FROM mimir.delivery_operations WHERE id=$1',[op.id])).rows[0].d;assert.ok(delay2>3.5&&delay2<=5.01,String(delay2));
    await sleep(5200);claim=await claimFor(op.id);assert.ok(claim);assert.equal(claim.attempt,3);assert.equal(claim.token,3);
    assert.equal(await port.handleAttemptFailure(claim,'DOCUMENT_INTEGRITY'),'FAILED');
    row=await operation(op.id);assert.equal(row.status,'FALHA');assert.equal(row.error_code,'DOCUMENT_INTEGRITY');assert.equal(row.attempt_count,3);
    assert.equal(await claimFor(op.id),null);assert.equal(await port.renewLease(claim),false);
    const swept=await owner('Synthetic I08 sweep');await seed(swept);const sop=await capture(swept);
    for(const expected of [1,2,3]){
      const c=await claimFor(sop.id);assert.ok(c,`attempt ${expected}`);assert.equal(c.attempt,expected);await expire(sop.id);
    }
    assert.equal(await claimFor(sop.id),null);
    row=await operation(sop.id);assert.equal(row.status,'FALHA');assert.equal(row.error_code,'ATTEMPTS_EXHAUSTED');assert.equal(row.attempt_count,3);
    assert.equal((await (await fetch(base+`/api/v1/operations/${sop.id}`,{headers:headers(swept)})).json()).status,'FALHA');
    const retry=await fetch(base+'/api/v1/deliveries',{method:'POST',headers:{...headers(swept),'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({periodMonth:'2026-11',expectedRevision:await revision(swept),rectificationReason:'Nova geracao'})});
    assert.equal(retry.status,202);const retryOp=await retry.json();assert.equal(retryOp.versionNumber,2);
    const worker=executor();for(let i=0;i<40&&(await operation(retryOp.id)).status!=='PRONTA';i++){await worker.tick();await sleep(60);}
    assert.equal((await operation(retryOp.id)).status,'PRONTA');
  });

  await t.test('executor turns a corrupted document read into a sanitised terminal failure after three attempts',async()=>{
    const who=await owner('Synthetic I08 corrupt');await seed(who);const op=await capture(who);
    const corrupting=Object.create(port);corrupting.readCapturedDocument=async(claim,id)=>{const bytes=await port.readCapturedDocument(claim,id);return Buffer.concat([bytes.subarray(0,5),Buffer.from('X'),bytes.subarray(6)]);};
    const outcomes=[];const logging=executor(corrupting,{log:event=>{if(event.operationId===op.id)outcomes.push(event.outcome);}});
    for(let i=0;i<300&&(await operation(op.id)).status!=='FALHA';i++){await logging.tick();await sleep(60);}
    const row=await operation(op.id);assert.equal(row.status,'FALHA');assert.equal(row.error_code,'DOCUMENT_INTEGRITY');assert.equal(row.attempt_count,3);
    assert.deepEqual(outcomes.filter(o=>o!=='LOST'),['RESCHEDULED','RESCHEDULED','FAILED']);assert.equal(await packages(op.id),0);
    const terminal=await fetch(base+`/api/v1/deliveries/${op.snapshotId}/package`,{headers:headers(who)});assert.equal(terminal.status,409);
    const state=await (await fetch(base+`/api/v1/operations/${op.id}`,{headers:headers(who)})).json();assert.equal(state.errorCode,'DOCUMENT_INTEGRITY');
    assert.deepEqual(await readdir(workRoot),[]);
  });

  await t.test('a stale executor loses the row mid-run: nothing is published and the new owner is untouched',async()=>{
    const who=await owner('Synthetic I08 takeover');await seed(who);const op=await capture(who);
    let thief=null;
    const racing=Object.create(port);racing.readSnapshot=async claim=>{
      const payload=await port.readSnapshot(claim);await expire(op.id);thief=await claimFor(op.id,'thief',otherPort);return payload;
    };
    const events=[],worker=executor(racing,{log:e=>{if(e.operationId===op.id)events.push(e.outcome);}});
    for(let i=0;i<50&&!events.length;i++){await worker.tick();await sleep(60);}
    assert.deepEqual(events,['LOST']);assert.ok(thief);assert.equal(thief.token,2);
    const row=await operation(op.id);assert.equal(row.status,'EM_PROCESSAMENTO');assert.equal(row.lease_holder,'thief');assert.equal(row.token,2);assert.equal(await packages(op.id),0);
    assert.deepEqual(await readdir(workRoot),[]);
    const zip=Buffer.from('thief zip'),manifest=Buffer.from('{}\n');
    assert.equal(await otherPort.publishPackage(thief,{zip,zipHash:sha(zip),manifest,manifestHash:sha(manifest)}),true);
  });

  await t.test('start removes orphaned temporary files only inside the controlled directory',async()=>{
    const root=await mkdtemp(join(tmpdir(),'mimir-i08-orphans-')),work=join(root,'delivery'),outside=join(root,'outside.txt');
    try{
      await mkdir(join(work,'abc-1'),{recursive:true});await writeFile(join(work,'abc-1','package.zip'),'orphan');await writeFile(outside,'keep');
      const worker=new DeliveryExecutor(port,{workRoot:work,pollMs:60000});await worker.start();await worker.stop();
      assert.deepEqual(await readdir(work),[]);assert.equal((await readdir(root)).includes('outside.txt'),true);
    }finally{await rm(root,{recursive:true,force:true});}
  });

  await t.test('grants, transition guard and publication closure are enforced by PostgreSQL',async()=>{
    const runtime=new pg.Client({connectionString:url.toString()});await runtime.connect();
    try{
      for(const sql of ['UPDATE mimir.delivery_packages SET zip_size=zip_size','DELETE FROM mimir.delivery_packages','TRUNCATE mimir.delivery_packages'])await assert.rejects(runtime.query(sql),e=>e.code==='42501');
      for(const sql of ['UPDATE mimir.delivery_operations SET workspace_id=workspace_id','UPDATE mimir.delivery_operations SET snapshot_id=snapshot_id','UPDATE mimir.delivery_operations SET created_at=created_at','DELETE FROM mimir.delivery_operations','TRUNCATE mimir.delivery_operations'])await assert.rejects(runtime.query(sql),e=>e.code==='42501');
      await assert.rejects(runtime.query('UPDATE mimir.delivery_snapshots SET payload=payload'),e=>e.code==='42501');
      await assert.rejects(runtime.query("UPDATE mimir.delivery_operations SET status='EM_FILA' WHERE id=$1",[ready.id]),e=>e.code==='23514','terminal operations are immutable');
      await assert.rejects(runtime.query("UPDATE mimir.delivery_operations SET status='FALHA',error_code='X' WHERE id=$1",[ready.id]),e=>e.code==='23514');
      const who=await owner('Synthetic I08 closure');await seed(who);const op=await capture(who);
      await assert.rejects(runtime.query("UPDATE mimir.delivery_operations SET status='PRONTA',completed_at=clock_timestamp() WHERE id=$1",[op.id]),e=>e.code==='23514','queued cannot jump to ready');
      await assert.rejects(runtime.query("UPDATE mimir.delivery_operations SET status='EM_PROCESSAMENTO',attempt_count=2,fencing_token=5,lease_holder='x',lease_expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1",[op.id]),e=>e.code==='23514','counters advance by exactly one');
      const claim=await claimFor(op.id);assert.ok(claim);
      await runtime.query('BEGIN');
      await runtime.query("UPDATE mimir.delivery_operations SET status='PRONTA',lease_holder=NULL,lease_expires_at=NULL,completed_at=clock_timestamp() WHERE id=$1",[op.id]);
      await assert.rejects(runtime.query('COMMIT'),e=>e.code==='23514','PRONTA without package is rejected at commit');
      assert.equal((await operation(op.id)).status,'EM_PROCESSAMENTO');
      const zip=Buffer.from('zip'),manifest=Buffer.from('{}\n'),insert=(token,hash=sha(zip))=>runtime.query(`INSERT INTO mimir.delivery_packages(id,workspace_id,snapshot_id,operation_id,zip_bytes,zip_size,zip_hash,manifest_bytes,manifest_hash,published_token) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [randomUUID(),claim.workspaceId,claim.snapshotId,claim.operationId,zip,zip.length,hash,manifest,sha(manifest),token]);
      await runtime.query('BEGIN');await insert(claim.token);
      await assert.rejects(runtime.query('COMMIT'),e=>e.code==='23514','package for a non-ready operation is rejected at commit');
      await assert.rejects(insert(claim.token,'0'.repeat(64)),e=>e.code==='23514','hash must match bytes');
      await runtime.query('ROLLBACK').catch(()=>{});
      assert.equal(await packages(op.id),0);
      await other(op,claim);
    }finally{await runtime.end();}
    async function other(op,claim){
      const zip=Buffer.from('zip'),manifest=Buffer.from('{}\n');
      assert.equal(await port.publishPackage({...claim,token:claim.token+1},{zip,zipHash:sha(zip),manifest,manifestHash:sha(manifest)}),false);
      assert.equal(await port.publishPackage(claim,{zip,zipHash:sha(zip),manifest,manifestHash:sha(manifest)}),true);
      assert.equal((await operation(op.id)).status,'PRONTA');
    }
  });
});
