import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {createOwner} from '../../tools/admin/owners.mjs';
import {PostgresAuthentication} from '../../apps/api/dist/adapters/postgres-auth.js';
import {PostgresPersistence} from '../../apps/api/dist/adapters/postgres.js';
import {PostgresAccounts} from '../../apps/api/dist/adapters/postgres-accounts.js';
import {PostgresPreview} from '../../apps/api/dist/adapters/postgres-preview.js';
import {AuthenticationService,sessionHash} from '../../apps/api/dist/auth/service.js';
import {createApp} from '../../apps/api/dist/server.js';

test('I07 capture: HTTP and real PostgreSQL',async t=>{
  const module=await import('../../apps/api/dist/adapters/postgres-deliveries.js').catch(()=>null);
  assert.ok(module,'I07 deliveries adapter missing');
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  const url=new URL(process.env.MIGRATION_DATABASE_URL);url.username='mimir_runtime';url.password=process.env.APP_ROLE_PASSWORD;
  const auth=new PostgresAuthentication(url.toString()),persistence=new PostgresPersistence(url.toString()),accounts=new PostgresAccounts(url.toString());
  const preview=new PostgresPreview(url.toString()),deliveries=new module.PostgresDeliveries(url.toString());
  const origin='http://127.0.0.1:3000',password=randomBytes(24).toString('hex'),logs=[];
  const service=await AuthenticationService.create(auth);
  const server=createApp(persistence,fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),
    {service,origins:new Set([origin]),allowLocalHttp:true,log:event=>logs.push(event)},accounts,undefined,undefined,preview,deliveries);
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await Promise.all([admin.end(),auth.close(),persistence.close(),accounts.close(),preview.close(),deliveries.close()]);});
  async function owner(label){
    const email=`${randomUUID()}@example.invalid`,identity=await createOwner({email,password,displayName:label,companyName:label});
    const r=await fetch(base+'/api/v1/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);
    return {...identity,token:r.headers.get('set-cookie').match(/^mimir_session=([a-f0-9]{64});/)[1],csrf:(await r.json()).csrfToken};
  }
  const a=await owner('Synthetic I07 A'),b=await owner('Synthetic I07 B');
  const actor=who=>({userId:who.userId,workspaceId:who.workspaceId,tokenHash:sessionHash(who.token)});
  const headers=(who=a)=>({Origin:origin,Cookie:`mimir_session=${who.token}`,'X-CSRF-Token':who.csrf});
  const revision=async(who=a)=>Number((await admin.query('SELECT revision::text n FROM mimir.workspaces WHERE id=$1',[who.workspaceId])).rows[0].n);
  const command=async(who=a,reason='')=>({periodMonth:'2026-11',expectedRevision:await revision(who),rectificationReason:reason});
  const post=(value,key=randomUUID(),who=a,extra={})=>fetch(base+'/api/v1/deliveries',{method:'POST',headers:{...headers(who),'Content-Type':'application/json','Idempotency-Key':key,...extra},body:JSON.stringify(value)});
  const get=(id,who=a)=>fetch(base+`/api/v1/operations/${id}`,{headers:headers(who)});
  const list=(month='2026-11',who=a,query='')=>fetch(base+`/api/v1/periods/${month}/deliveries${query}`,{headers:headers(who)});
  const counts=async(who=a)=>(await admin.query(`SELECT
    (SELECT count(*)::int FROM mimir.delivery_snapshots WHERE workspace_id=$1) snapshots,
    (SELECT count(*)::int FROM mimir.snapshot_documents WHERE workspace_id=$1) refs,
    (SELECT count(*)::int FROM mimir.delivery_operations WHERE workspace_id=$1) operations,
    (SELECT count(*)::int FROM mimir.idempotency_keys WHERE workspace_id=$1) keys`,[who.workspaceId])).rows[0];
  async function settle(operation,status){
    const row=(await admin.query('SELECT workspace_id,snapshot_id FROM mimir.delivery_operations WHERE id=$1',[operation])).rows[0];
    await admin.query('BEGIN');
    try{
      await admin.query("UPDATE mimir.delivery_operations SET status='EM_PROCESSAMENTO',attempt_count=1,fencing_token=1,lease_holder='synthetic',lease_expires_at=clock_timestamp()+interval '30 seconds',next_retry_at=NULL WHERE id=$1",[operation]);
      if(status==='FALHA')await admin.query("UPDATE mimir.delivery_operations SET status='FALHA',error_code='SYNTHETIC_FAILURE',lease_holder=NULL,lease_expires_at=NULL,completed_at=clock_timestamp() WHERE id=$1",[operation]);
      else{
        const zip=Buffer.from('synthetic zip'),manifest=Buffer.from('{}\n'),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
        await admin.query('INSERT INTO mimir.delivery_packages(id,workspace_id,snapshot_id,operation_id,zip_bytes,zip_size,zip_hash,manifest_bytes,manifest_hash,published_token) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1)',
          [randomUUID(),row.workspace_id,row.snapshot_id,operation,zip,zip.length,digest(zip),manifest,digest(manifest)]);
        await admin.query("UPDATE mimir.delivery_operations SET status='PRONTA',lease_holder=NULL,lease_expires_at=NULL,completed_at=clock_timestamp() WHERE id=$1",[operation]);
      }
      await admin.query('COMMIT');
    }catch(error){await admin.query('ROLLBACK');throw error;}
  }
  async function seed(who=a,month='2026-11',withDoc=true){
    const account=randomUUID(),tx=randomUUID(),doc=randomUUID(),bytes=Buffer.from('%PDF-1.7\nSynthetic I07\n%%EOF\n');
    await admin.query('INSERT INTO mimir.accounts(id,workspace_id,name,name_key,account_type) VALUES($1,$2,$3,$4,$5)',[account,who.workspaceId,'Synthetic PF '+account,'synthetic '+account,'PF']);
    await admin.query('INSERT INTO mimir.periods(id,workspace_id,period_month,notes) VALUES($1,$2,$3,$4) ON CONFLICT (workspace_id,period_month) DO NOTHING',[randomUUID(),who.workspaceId,month,'Synthetic notes']);
    await admin.query(`INSERT INTO mimir.transactions(id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,description,category,classification,is_pf_business_expense,explanation,source_type,source_code,external_id,status)
      VALUES($1,$2,$3,$4,$5,'SAIDA',1250,'Synthetic I07','Geral','DESPESA',true,'','MANUAL','MANUAL',$1::uuid::text,'ATIVA')`,[tx,who.workspaceId,account,month+'-01',month]);
    if(withDoc){await admin.query('INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[doc,who.workspaceId,'synthetic.pdf','application/pdf',bytes.length,createHash('sha256').update(bytes).digest('hex'),bytes]);
      await admin.query('INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id) VALUES($1,$2,$3)',[who.workspaceId,tx,doc]);}
    return {account,tx,doc};
  }
  async function addBulk(who,account,number){
    await admin.query(`INSERT INTO mimir.transactions(id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,description,category,classification,is_pf_business_expense,explanation,source_type,source_code,external_id,status)
      SELECT md5($1::text || ':' || g::text)::uuid,$1::uuid,$2::uuid,DATE '2026-11-01','2026-11','SAIDA',1,'Synthetic bulk','Geral','DESPESA',false,'','MANUAL','MANUAL',g::text,'ATIVA'
      FROM generate_series(1,$3::integer) g`,[who.workspaceId,account,number]);
  }
  await t.test('empty and stale requests do not persist; authentication and exact HTTP input are enforced',async()=>{
    const before=await counts(),rev=await revision();
    const empty=await post(await command());assert.equal(empty.status,422);assert.equal((await empty.json()).code,'EMPTY_PERIOD');
    const stale=await post({...await command(),expectedRevision:rev+1});assert.equal(stale.status,409);
    const body=await command();
    for(const [extra,status] of [[{Cookie:''},401],[{'X-CSRF-Token':''},403],[{Origin:'http://untrusted.invalid'},403]])assert.equal((await post(body,randomUUID(),a,extra)).status,status);
    for(const value of [{...body,other:1},{...body,periodMonth:'2026-13'},{...body,expectedRevision:'1'},{...body,rectificationReason:null}])assert.equal((await post(value)).status,422);
    for(const key of ['short','é'.repeat(16),'x'.repeat(129)])assert.equal((await post(body,key)).status,422);
    assert.equal((await fetch(base+'/api/v1/deliveries?extra=1',{method:'POST',headers:{...headers(),'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(body)})).status,400);
    assert.deepEqual(await counts(),before);assert.equal(await revision(),rev);
  });
  const seeded=await seed();await seed(b);let firstCapture,secondCapture;
  await t.test('capture stores complete immutable payload and document refs without advancing revision',async()=>{
    const rev=await revision(),key=randomUUID(),body=await command();
    const r=await post(body,key);assert.equal(r.status,202);const op=await r.json();
    assert.deepEqual(Object.keys(op).sort(),['id','snapshotId','periodMonth','versionNumber','capturedRevision','status','attemptCount','errorCode','createdAt','completedAt'].sort());
    assert.equal(op.status,'EM_FILA');assert.equal(op.versionNumber,1);assert.equal(op.capturedRevision,rev);assert.equal(op.attemptCount,0);assert.equal(op.errorCode,null);assert.equal(op.completedAt,null);
    assert.equal(await revision(),rev);assert.deepEqual(await counts(),{snapshots:1,refs:1,operations:1,keys:1});
    const row=(await admin.query('SELECT payload,version_number,captured_revision,rectification_reason FROM mimir.delivery_snapshots WHERE workspace_id=$1 AND id=$2',[a.workspaceId,op.snapshotId])).rows[0];
    const p=row.payload;assert.equal(p.schemaVersion,'mimir.snapshot.v1');assert.equal(row.version_number,1);assert.equal(Number(row.captured_revision),rev);assert.equal(row.rectification_reason,'');
    assert.equal(p.workspace.workspaceId,a.workspaceId);assert.equal(p.delivery.snapshotId,op.snapshotId);assert.equal(p.delivery.operationId,op.id);
    assert.equal(p.transactions.length,1);assert.equal(p.transactions[0].transactionId,seeded.tx);assert.deepEqual(p.transactions[0].documentIds,[seeded.doc]);
    assert.deepEqual(p.contextTransactions,[]);assert.deepEqual(p.reimbursementLinks,[]);assert.equal(p.documents.length,1);
    assert.deepEqual(p.documents[0],{documentId:seeded.doc,originalName:'synthetic.pdf',mimeType:'application/pdf',sizeBytes:Buffer.from('%PDF-1.7\nSynthetic I07\n%%EOF\n').length,sha256:createHash('sha256').update(Buffer.from('%PDF-1.7\nSynthetic I07\n%%EOF\n')).digest('hex')});
    assert.equal(p.period.periodMonth,'2026-11');assert.equal(p.period.notes,'Synthetic notes');assert.equal(p.summary.businessExpenseTotalCents,1250);
    const ref=(await admin.query('SELECT document_id FROM mimir.snapshot_documents WHERE workspace_id=$1 AND snapshot_id=$2',[a.workspaceId,op.snapshotId])).rows;assert.deepEqual(ref.map(x=>x.document_id),[seeded.doc]);
    const stored=(await admin.query('SELECT request_fingerprint FROM mimir.idempotency_keys WHERE workspace_id=$1 AND key=$2',[a.workspaceId,key])).rows[0].request_fingerprint;
    assert.equal(stored,createHash('sha256').update(Buffer.from(JSON.stringify([1,body.periodMonth,body.expectedRevision,body.rectificationReason]),'utf8')).digest('hex'));
    assert.equal((await get(op.id)).status,200);assert.equal((await get(op.id,b)).status,404);assert.equal((await get(randomUUID())).status,404);
    const forged={userId:b.userId,workspaceId:a.workspaceId,tokenHash:sessionHash(b.token)};
    await assert.rejects(deliveries.captureDelivery(forged,body,randomUUID()),e=>e.status===401);
    await assert.rejects(deliveries.getOperation(forged,op.id),e=>e.status===401);
    await assert.rejects(deliveries.listDeliveries(forged,'2026-11',{cursor:null,limit:100}),e=>e.status===401);
    firstCapture={op,key,body,payload:p};
  });
  await t.test('same key precedes revision check; normalized replay matches, altered fingerprint conflicts',async()=>{
    const {op,key,body}=firstCapture;
    await admin.query('UPDATE mimir.workspaces SET revision=revision+1 WHERE id=$1',[a.workspaceId]);
    const repeat=await post(body,key);assert.equal(repeat.status,202);assert.deepEqual(await repeat.json(),op);
    const mismatch=await post({...body,expectedRevision:body.expectedRevision+1},key);assert.equal(mismatch.status,409);assert.equal((await mismatch.json()).code,'IDEMPOTENCY_PAYLOAD_MISMATCH');
    assert.equal((await post({...body,rectificationReason:'changed'},key)).status,409);
    assert.deepEqual(await counts(),{snapshots:1,refs:1,operations:1,keys:1});
  });
  await t.test('new version requires reason; old payload survives source mutation and terminal replay stays terminal',async()=>{
    const {op,key,body,payload}=firstCapture;
    await admin.query('UPDATE mimir.transactions SET amount_cents=9999 WHERE id=$1',[seeded.tx]);
    await admin.query('UPDATE mimir.periods SET notes=$1 WHERE workspace_id=$2 AND period_month=$3',['Changed notes',a.workspaceId,'2026-11']);
    const noReason=await post(await command());assert.equal(noReason.status,422);
    const shortReason=await post(await command(),'x'.repeat(16));assert.equal(shortReason.status,422);
    const c=await command(a,'  Cafe\u0301\r\n revisão  '),v2key=randomUUID(),next=await post(c,v2key);assert.equal(next.status,202);const v2=await next.json();assert.equal(v2.versionNumber,2);
    secondCapture={c,v2key,v2};
    const first=(await admin.query('SELECT payload FROM mimir.delivery_snapshots WHERE id=$1',[op.snapshotId])).rows[0].payload;assert.deepEqual(first,payload);
    const second=(await admin.query('SELECT payload,rectification_reason FROM mimir.delivery_snapshots WHERE id=$1',[v2.snapshotId])).rows[0];assert.equal(second.payload.transactions[0].amountCents,9999);assert.equal(second.payload.period.notes,'Changed notes');assert.equal(second.rectification_reason,'Café\n revisão');
    await settle(op.id,'FALHA');
    const replay=await post(body,key);assert.equal(replay.status,200);const terminal=await replay.json();assert.equal(terminal.id,op.id);assert.equal(terminal.status,'FALHA');assert.equal(terminal.attemptCount,1);assert.equal(terminal.errorCode,'SYNTHETIC_FAILURE');
    assert.equal((await get(op.id)).status,200);assert.deepEqual(await counts(),{snapshots:2,refs:2,operations:2,keys:2});
  });
  await t.test('PRONTA replay with equivalent normalized command returns original terminal operation',async()=>{
    const {c,v2key,v2}=secondCapture;
    await settle(v2.id,'PRONTA');
    const canonical={...c,rectificationReason:'Café\n revisão'};
    const ready=await post(canonical,v2key);assert.equal(ready.status,200);const body=await ready.json();assert.equal(body.id,v2.id);assert.equal(body.status,'PRONTA');assert.equal(body.attemptCount,1);
    assert.deepEqual(await counts(),{snapshots:2,refs:2,operations:2,keys:2});
  });
  await t.test('history is owner scoped, ordered by version and validates cursor/query',async()=>{
    const r=await list();assert.equal(r.status,200);const page=await r.json();assert.deepEqual(page.items.map(x=>x.versionNumber),[1,2]);assert.equal(page.nextCursor,null);
    const first=await list('2026-11',a,'?limit=1');assert.equal(first.status,200);const p=await first.json();assert.equal(p.items.length,1);assert.equal(p.items[0].versionNumber,1);assert.ok(p.nextCursor);
    const last=await list('2026-11',a,`?limit=1&cursor=${p.nextCursor}`);assert.equal(last.status,200);assert.deepEqual((await last.json()).items.map(x=>x.versionNumber),[2]);
    assert.deepEqual((await (await list('2026-11',b)).json()).items,[]);
    for(const q of ['?limit=0','?limit=201','?limit=1&limit=2','?cursor=bad','?cursor='+randomUUID(),'?other=1'])assert.notEqual((await list('2026-11',a,q)).status,200);
  });
  await t.test('same and distinct keys serialize capture; repeat has one snapshot and distinct key needs reason',async()=>{
    const who=await owner('Synthetic I07 concurrency');await seed(who);const c=await command(who),key=randomUUID();
    const same=await Promise.all([post(c,key,who),post(c,key,who)]);assert.deepEqual(same.map(x=>x.status).sort(),[202,202]);
    assert.equal((await same[0].json()).id,(await same[1].json()).id);assert.deepEqual(await counts(who),{snapshots:1,refs:1,operations:1,keys:1});
    const rectification={...c,rectificationReason:'Synthetic retry'};
    const distinct=await Promise.all([post(rectification,randomUUID(),who),post(rectification,randomUUID(),who)]);assert.deepEqual(distinct.map(x=>x.status).sort(),[202,202]);
    assert.deepEqual(await counts(who),{snapshots:3,refs:3,operations:3,keys:3});
    assert.deepEqual((await (await list('2026-11',who)).json()).items.map(x=>x.versionNumber),[1,2,3]);
  });
  await t.test('capture accepts exactly 1000 records and rejects 1001 without truncation or another key',async()=>{
    const who=await owner('Synthetic I07 count limit'),row=await seed(who,'2026-11',false);
    await addBulk(who,row.account,999);
    const accepted=await post(await command(who),randomUUID(),who);assert.equal(accepted.status,202);
    const op=await accepted.json(),payload=(await admin.query('SELECT payload,transaction_count FROM mimir.delivery_snapshots WHERE id=$1',[op.snapshotId])).rows[0];
    assert.equal(payload.transaction_count,1000);assert.equal(payload.payload.transactions.length,1000);
    await admin.query(`INSERT INTO mimir.transactions(id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,description,category,classification,is_pf_business_expense,explanation,source_type,source_code,external_id,status)
      VALUES($1,$2,$3,DATE '2026-11-01','2026-11','SAIDA',1,'Synthetic overflow','Geral','DESPESA',false,'','MANUAL','MANUAL','overflow','ATIVA')`,[randomUUID(),who.workspaceId,row.account]);
    const before=await counts(who),rejected=await post(await command(who),randomUUID(),who);assert.equal(rejected.status,413);assert.deepEqual(await counts(who),before);
  });
  await t.test('1000 records, 1000 unique documents and 10000 associations close; document 1001 exceeds only document count',async()=>{
    const who=await owner('Synthetic I07 all boundaries'),row=await seed(who,'2026-11',false);await addBulk(who,row.account,999);
    const hash=createHash('sha256').update(Buffer.from('x')).digest('hex');
    await admin.query(`INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes)
      SELECT md5($1::text || ':doc:' || g::text)::uuid,$1::uuid,'synthetic-'||g::text||'.pdf','application/pdf',1,$2,decode('78','hex')
      FROM generate_series(1,1000) g`,[who.workspaceId,hash]);
    await admin.query(`WITH ordered_transactions AS (
        SELECT id,row_number() OVER (ORDER BY id)::integer AS n FROM mimir.transactions WHERE workspace_id=$1
      ) INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id)
      SELECT $1::uuid,t.id,md5($1::text || ':doc:' || (((t.n-1)*10+k-1)%1000+1)::text)::uuid
      FROM ordered_transactions t CROSS JOIN generate_series(1,10) k`,[who.workspaceId]);
    const accepted=await post(await command(who),randomUUID(),who);assert.equal(accepted.status,202);
    const op=await accepted.json(),snapshot=(await admin.query('SELECT transaction_count,document_count,document_bytes,payload FROM mimir.delivery_snapshots WHERE id=$1',[op.snapshotId])).rows[0];
    assert.equal(snapshot.transaction_count,1000);assert.equal(snapshot.document_count,1000);assert.equal(Number(snapshot.document_bytes),1000);
    assert.equal(snapshot.payload.transactions.length,1000);assert.equal(snapshot.payload.documents.length,1000);
    assert.equal(snapshot.payload.transactions.reduce((n,x)=>n+x.documentIds.length,0),10000);
    assert.equal((await admin.query('SELECT count(*)::int n FROM mimir.snapshot_documents WHERE snapshot_id=$1',[op.snapshotId])).rows[0].n,1000);
    const oldLink=(await admin.query('SELECT transaction_id,document_id FROM mimir.transaction_documents WHERE workspace_id=$1 LIMIT 1',[who.workspaceId])).rows[0];
    await admin.query('DELETE FROM mimir.transaction_documents WHERE workspace_id=$1 AND transaction_id=$2 AND document_id=$3',[who.workspaceId,oldLink.transaction_id,oldLink.document_id]);
    const extra=randomUUID();await admin.query('INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes) VALUES($1,$2,$3,$4,1,$5,$6)',[extra,who.workspaceId,'synthetic-extra.pdf','application/pdf',hash,Buffer.from('x')]);
    await admin.query('INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id) VALUES($1,$2,$3)',[who.workspaceId,oldLink.transaction_id,extra]);
    const before=await counts(who),rejected=await post(await command(who,'Synthetic additional document'),randomUUID(),who);
    assert.equal(rejected.status,413);assert.deepEqual(await counts(who),before);
  });
  await t.test('capture rejects an 8 MiB payload built from valid Unicode pending fields',async()=>{
    const who=await owner('Synthetic I07 payload limit'),row=await seed(who,'2026-11',false);await addBulk(who,row.account,249);
    const huge='界'.repeat(2000);
    await admin.query(`INSERT INTO mimir.pending_items(id,workspace_id,transaction_id,type,status,description,justification)
      SELECT md5(t.id::text || ':' || kind)::uuid,t.workspace_id,t.id,kind,'JUSTIFICADA',$2,$2
      FROM mimir.transactions t CROSS JOIN unnest(ARRAY['DOCUMENTO_AUSENTE','CLASSIFICACAO_A_ESCLARECER','REEMBOLSO_PF_PENDENTE','DUVIDA_CADASTRADA']) kind
      WHERE t.workspace_id=$1`,[who.workspaceId,huge]);
    const before=await counts(who),r=await post(await command(who),randomUUID(),who);assert.equal(r.status,413);assert.deepEqual(await counts(who),before);
  });
  await t.test('capture waits on workspace mutation, then rejects stale revision without partial writes',async()=>{
    const who=await owner('Synthetic I07 lock');const row=await seed(who),c=await command(who);
    const blocker=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});
    const observer=new pg.Client({connectionString:process.env.PROVISION_DATABASE_URL});
    await blocker.connect();await observer.connect();let open=false,response;
    try{
      await blocker.query('BEGIN');open=true;
      await blocker.query('SELECT id FROM mimir.workspaces WHERE id=$1 FOR UPDATE',[who.workspaceId]);
      response=post(c,randomUUID(),who);
      let waiting=false;
      for(let i=0;i<100;i++){
        waiting=(await observer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='mimir_runtime' AND wait_event_type='Lock' AND query LIKE '%workspaces%') waiting")).rows[0].waiting;
        if(waiting)break;await new Promise(r=>setTimeout(r,10));
      }
      assert.equal(waiting,true,'capture must wait for workspace lock');
      await blocker.query('UPDATE mimir.workspaces SET revision=revision+1 WHERE id=$1',[who.workspaceId]);
      await blocker.query('UPDATE mimir.transactions SET amount_cents=7777 WHERE id=$1',[row.tx]);
      await blocker.query('COMMIT');open=false;
      assert.equal((await response).status,409);assert.deepEqual(await counts(who),{snapshots:0,refs:0,operations:0,keys:0});
      const fresh=await post(await command(who),randomUUID(),who);assert.equal(fresh.status,202);
      const op=await fresh.json(),payload=(await admin.query('SELECT payload FROM mimir.delivery_snapshots WHERE id=$1',[op.snapshotId])).rows[0].payload;
      assert.equal(payload.transactions[0].amountCents,7777);
    }finally{if(open)await blocker.query('ROLLBACK');await response?.catch(()=>{});await blocker.end();await observer.end();}
  });
  await t.test('session revoked while capture waits on workspace lock cannot write the aggregate',async()=>{
    const who=await owner('Synthetic I07 revoked lock');await seed(who);
    const blocker=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});
    const observer=new pg.Client({connectionString:process.env.PROVISION_DATABASE_URL});
    await blocker.connect();await observer.connect();let open=false,response;
    try{
      await blocker.query('BEGIN');open=true;
      await blocker.query('SELECT id FROM mimir.workspaces WHERE id=$1 FOR UPDATE',[who.workspaceId]);
      response=post(await command(who),randomUUID(),who);
      let waiting=false;
      for(let i=0;i<100;i++){
        waiting=(await observer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='mimir_runtime' AND wait_event_type='Lock' AND query LIKE '%workspaces%') waiting")).rows[0].waiting;
        if(waiting)break;await new Promise(r=>setTimeout(r,10));
      }
      assert.equal(waiting,true,'capture must wait before post-lock session reauthorization');
      await admin.query('UPDATE mimir.sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[sessionHash(who.token)]);
      await blocker.query('COMMIT');open=false;
      assert.equal((await response).status,401);assert.deepEqual(await counts(who),{snapshots:0,refs:0,operations:0,keys:0});
    }finally{if(open)await blocker.query('ROLLBACK');await response?.catch(()=>{});await blocker.end();await observer.end();}
  });
  await t.test('failure at every write stage rolls back snapshot, refs, operation and key',async()=>{
    for(const table of ['delivery_snapshots','snapshot_documents','delivery_operations','idempotency_keys']){
      const who=await owner('Synthetic I07 rollback '+table);await seed(who);const before=await counts(who),suffix=randomBytes(5).toString('hex');
      await admin.query(`CREATE FUNCTION mimir.fail_i07_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${who.workspaceId}'::uuid THEN RAISE EXCEPTION 'Synthetic rollback'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER fail_i07_${suffix} BEFORE INSERT ON mimir.${table} FOR EACH ROW EXECUTE FUNCTION mimir.fail_i07_${suffix}()`);
      try{const r=await post(await command(who),randomUUID(),who);assert.equal(r.status,500);assert.equal((await r.json()).code,'INTERNAL_ERROR');assert.deepEqual(await counts(who),before);}
      finally{await admin.query(`DROP TRIGGER fail_i07_${suffix} ON mimir.${table}`);await admin.query(`DROP FUNCTION mimir.fail_i07_${suffix}()`);}
    }
  });
  await t.test('runtime grants, composite FKs and deferred closure reject mutations, foreign and extra references',async()=>{
    const runtime=new pg.Client({connectionString:url.toString()});await runtime.connect();
    try{
      for(const table of ['delivery_snapshots','snapshot_documents','delivery_operations','idempotency_keys'])for(const sql of [`UPDATE mimir.${table} SET workspace_id=workspace_id`,`DELETE FROM mimir.${table}`,`TRUNCATE mimir.${table}`])await assert.rejects(runtime.query(sql),e=>e.code==='42501');
      await assert.rejects(runtime.query('CREATE TABLE mimir.i07_forbidden(id int)'),e=>e.code==='42501');
      const {op}=firstCapture;
      await assert.rejects(runtime.query('INSERT INTO mimir.snapshot_documents(workspace_id,snapshot_id,document_id) VALUES($1,$2,$3)',[a.workspaceId,op.snapshotId,randomUUID()]),e=>e.code==='23503');
      const otherDoc=(await admin.query('SELECT id FROM mimir.documents WHERE workspace_id=$1 LIMIT 1',[b.workspaceId])).rows[0].id;
      await assert.rejects(runtime.query('INSERT INTO mimir.snapshot_documents(workspace_id,snapshot_id,document_id) VALUES($1,$2,$3)',[a.workspaceId,op.snapshotId,otherDoc]),e=>e.code==='23503');
      const extra=randomUUID(),bytes=Buffer.from('synthetic');await admin.query('INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[extra,a.workspaceId,'extra.pdf','application/pdf',bytes.length,createHash('sha256').update(bytes).digest('hex'),bytes]);
      await assert.rejects(runtime.query('INSERT INTO mimir.snapshot_documents(workspace_id,snapshot_id,document_id) VALUES($1,$2,$3)',[a.workspaceId,op.snapshotId,extra]));
      assert.deepEqual(await counts(),{snapshots:2,refs:2,operations:2,keys:2});
    }finally{await runtime.end();}
  });
  await t.test('deferred closure rejects a new snapshot whose payload names a missing document reference',async()=>{
    const snapshotId=randomUUID(),operationId=randomUUID(),capturedAt=new Date().toISOString(),rev=await revision();
    const payload=structuredClone(firstCapture.payload);payload.delivery={...payload.delivery,snapshotId,operationId,versionNumber:3,capturedRevision:rev,rectificationReason:'Synthetic closure',capturedAt};
    await admin.query('BEGIN');
    try{
      await admin.query(`INSERT INTO mimir.delivery_snapshots(id,workspace_id,operation_id,period_month,version_number,captured_revision,rectification_reason,captured_at,payload,transaction_count,document_count,document_bytes)
        VALUES($1,$2,$3,'2026-11',3,$4,'Synthetic closure',$5,$6,1,1,$7)`,[snapshotId,a.workspaceId,operationId,rev,capturedAt,payload,Buffer.from('%PDF-1.7\nSynthetic I07\n%%EOF\n').length]);
      await admin.query('INSERT INTO mimir.delivery_operations(id,workspace_id,snapshot_id) VALUES($1,$2,$3)',[operationId,a.workspaceId,snapshotId]);
      await assert.rejects(admin.query('COMMIT'),e=>e.code==='23514');
    }finally{await admin.query('ROLLBACK');}
    assert.deepEqual(await counts(),{snapshots:2,refs:2,operations:2,keys:2});
  });
  for(const log of logs)assert.deepEqual(Object.keys(log).sort(),['durationMs','operation','requestId','status']);
});
