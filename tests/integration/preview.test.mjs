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
import {AuthenticationService,sessionHash} from '../../apps/api/dist/auth/service.js';
import {createApp} from '../../apps/api/dist/server.js';

test('I06 preview: actual HTTP and PostgreSQL',async t=>{
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  const runtimeUrl=new URL(process.env.MIGRATION_DATABASE_URL);runtimeUrl.username='mimir_runtime';runtimeUrl.password=process.env.APP_ROLE_PASSWORD;
  const auth=new PostgresAuthentication(runtimeUrl.toString()),persistence=new PostgresPersistence(runtimeUrl.toString()),accounts=new PostgresAccounts(runtimeUrl.toString());
  const previewModule=await import('../../apps/api/dist/adapters/postgres-preview.js').catch(()=>null);
  assert.ok(previewModule,'I06 preview persistence missing');
  const preview=new previewModule.PostgresPreview(runtimeUrl.toString());
  const service=await AuthenticationService.create(auth),origin='http://127.0.0.1:3000',logs=[];
  const server=createApp(persistence,fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),
    {service,origins:new Set([origin]),allowLocalHttp:true,log:event=>logs.push(event)},accounts,undefined,undefined,preview);
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await Promise.all([admin.end(),auth.close(),persistence.close(),accounts.close(),preview.close()]);});
  const password=randomBytes(24).toString('hex');
  async function owner(label){
    const email=`${randomUUID()}@example.invalid`,identity=await createOwner({email,password,displayName:label,companyName:label});
    const login=await fetch(base+'/api/v1/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(login.status,200);
    return {...identity,token:login.headers.get('set-cookie').match(/^mimir_session=([a-f0-9]{64});/)[1],csrf:(await login.json()).csrfToken};
  }
  const a=await owner('Synthetic I06 A'),b=await owner('Synthetic I06 B');
  const actor=who=>({userId:who.userId,workspaceId:who.workspaceId,tokenHash:sessionHash(who.token)});
  const get=(month='2026-11',who=a,headers={})=>fetch(base+`/api/v1/periods/${month}/preview`,{headers:{Cookie:`mimir_session=${who.token}`,Origin:origin,...headers}});
  const revision=async(who=a)=>Number((await admin.query('SELECT revision::text AS n FROM mimir.workspaces WHERE id=$1',[who.workspaceId])).rows[0].n);
  const counts=async(who=a)=>(await admin.query(`SELECT
    (SELECT count(*)::int FROM mimir.periods WHERE workspace_id=$1) periods,
    (SELECT count(*)::int FROM mimir.transactions WHERE workspace_id=$1) transactions,
    (SELECT count(*)::int FROM mimir.pending_items WHERE workspace_id=$1) pending`,[who.workspaceId])).rows[0];
  async function account(who,type,name){const id=randomUUID();await admin.query('INSERT INTO mimir.accounts(id,workspace_id,name,name_key,account_type) VALUES($1,$2,$3,$4,$5)',[id,who.workspaceId,name,name.toLowerCase(),type]);return id;}
  async function add(who,accountId,fields={}){
    const id=randomUUID(),date=fields.date??'2026-11-01',month=date.slice(0,7),direction=fields.direction??'SAIDA',classification=fields.classification??'DESPESA';
    await admin.query('INSERT INTO mimir.periods(id,workspace_id,period_month) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[randomUUID(),who.workspaceId,month]);
    await admin.query(`INSERT INTO mimir.transactions(id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,description,category,classification,is_pf_business_expense,explanation,source_type,source_code,external_id,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'','MANUAL','MANUAL',$1::uuid::text,$12)`,
      [id,who.workspaceId,accountId,date,month,direction,fields.amount??100,fields.description??'Synthetic I06',fields.category??'Geral',classification,fields.business??false,fields.status??'ATIVA']);
    return id;
  }
  const pending=async(who,tx,type,status,justification='')=>{const id=randomUUID();await admin.query(`INSERT INTO mimir.pending_items(id,workspace_id,transaction_id,type,status,description,justification)
    VALUES($1,$2,$3,$4,$5,'Synthetic pending',$6)`,[id,who.workspaceId,tx,type,status,justification]);return id;};
  await t.test('empty and boundary months have exact contract shape and do not create period or change revision',async()=>{
    const before=await counts();const rev=await revision();
    for(const month of ['1900-01','2000-02','9999-12']){
      const r=await get(month);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const x=await r.json();
      assert.deepEqual(Object.keys(x).sort(),['workspace','periodMonth','revision','summary','transactions','contextTransactions','reimbursementLinks','pendingItems'].sort());
      assert.deepEqual(x.workspace,{workspaceId:a.workspaceId,companyName:'Synthetic I06 A',currency:'BRL'});
      assert.equal(x.periodMonth,month);assert.equal(x.revision,rev);assert.deepEqual(x.transactions,[]);assert.deepEqual(x.contextTransactions,[]);
      assert.deepEqual(x.reimbursementLinks,[]);assert.deepEqual(x.pendingItems,[]);
      assert.deepEqual(x.summary,{cashFlowByAccount:[],businessRevenueTotalCents:0,businessExpenseTotalCents:0,
        reimbursementsSettledInPeriodCents:0,pendingCount:0,justifiedCount:0,categoryTotals:[]});
    }
    assert.deepEqual(await counts(),before);assert.equal(await revision(),rev);
  });
  await t.test('auth, owner, origin, month/query and method reject before a read response',async()=>{
    assert.equal((await get('2026-11',a,{Cookie:''})).status,401);
    assert.equal((await get('2026-11',a,{Cookie:`mimir_session=${a.token}; mimir_session=${a.token}`})).status,401);
    assert.equal((await get('2026-11',a,{Origin:'http://evil.invalid'})).status,403);
    for(const month of ['1899-12','2026-00','2026-13','2026-1'])assert.equal((await get(month)).status,422);
    assert.equal((await fetch(base+'/api/v1/periods/2026-11/preview?x=1',{headers:{Cookie:`mimir_session=${a.token}`,Origin:origin}})).status,400);
    assert.equal((await fetch(base+'/api/v1/periods/2026-11/preview',{method:'POST',headers:{Cookie:`mimir_session=${a.token}`,Origin:origin}})).status,405);
    await assert.rejects(preview.readPeriodPreview({userId:a.userId,workspaceId:b.workspaceId,tokenHash:sessionHash(a.token)},'2026-11'),e=>e.status===401);
  });
  await t.test('revoked or expired session and inactive owner return 401',async()=>{
    for(const state of ['revoked','expired','inactive']){
      const who=await owner('Synthetic I06 '+state);
      if(state==='revoked')await admin.query('UPDATE mimir.sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[sessionHash(who.token)]);
      if(state==='expired')await admin.query("UPDATE mimir.sessions SET created_at=clock_timestamp()-interval '9 hours',expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[sessionHash(who.token)]);
      if(state==='inactive')await admin.query('UPDATE mimir.users SET active=false WHERE id=$1',[who.userId]);
      assert.equal((await get('2026-11',who)).status,401);
    }
  });
  await t.test('civil leap and extreme dates retain exact YYYY-MM-DD without timezone shift',async()=>{
    const who=await owner('Synthetic I06 dates'),id=await account(who,'PF','Date PF');
    for(const date of ['1900-01-01','2000-02-29','9999-12-31']){
      const tx=await add(who,id,{date,classification:'TRANSFERENCIA'}),r=await get(date.slice(0,7),who);
      assert.equal(r.status,200);const x=await r.json();assert.equal(x.transactions.length,1);
      assert.equal(x.transactions[0].transactionId,tx);assert.equal(x.transactions[0].occurredOn,date);
    }
    const adjacent=await get('2000-03',who);assert.equal(adjacent.status,200);assert.deepEqual((await adjacent.json()).transactions,[]);
  });
  const pf=await account(a,'PF','Synthetic PF'),pj=await account(a,'PJ','Synthetic PJ');
  await account(b,'PJ','Foreign PJ');const foreignTx=await add(b,(await admin.query('SELECT id FROM mimir.accounts WHERE workspace_id=$1',[b.workspaceId])).rows[0].id,{direction:'ENTRADA',classification:'RECEITA',amount:99999999999});
  const pfExpense=await add(a,pf,{date:'2026-11-01',amount:100,category:'Ética',business:true});
  const pfRevenue=await add(a,pf,{date:'2026-11-02',direction:'ENTRADA',classification:'RECEITA',amount:120,category:'Ética'});
  const pjRevenue=await add(a,pj,{date:'2026-11-02',direction:'ENTRADA',classification:'RECEITA',amount:500,category:'Água'});
  const transfer=await add(a,pj,{date:'2026-11-03',classification:'TRANSFERENCIA',amount:50,category:'z'});
  const pjExpense=await add(a,pj,{date:'2026-11-04',amount:70,category:'Água'});
  await add(a,pf,{date:'2026-10-31',amount:777,category:'Contexto'});
  await add(a,pf,{date:'2026-11-05',amount:888,category:'Excluída',status:'EXCLUIDA'});
  const p1=await pending(a,pfExpense,'DOCUMENTO_AUSENTE','RESOLVIDA');
  const p2=await pending(a,pfExpense,'REEMBOLSO_PF_PENDENTE','PENDENTE');
  const p3=await pending(a,pjExpense,'DUVIDA_CADASTRADA','JUSTIFICADA','Synthetic reason');
  const bytes=Buffer.from('%PDF-1.7\nSynthetic I06\n%%EOF\n'),hash=createHash('sha256').update(bytes).digest('hex'),doc=randomUUID();
  await admin.query('INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[doc,a.workspaceId,'synthetic.pdf','application/pdf',bytes.length,hash,bytes]);
  for(const tx of [pfExpense,pjExpense])await admin.query('INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id) VALUES($1,$2,$3)',[a.workspaceId,tx,doc]);
  await admin.query('UPDATE mimir.accounts SET active=false WHERE id=$1',[pf]);
  await t.test('principal selection, civil dates, documents, pending states and independent money oracles',async()=>{
    const before=await counts(),rev=await revision();const r=await get();assert.equal(r.status,200);const x=await r.json();
    assert.equal(x.revision,rev);assert.equal(x.transactions.length,5);assert.deepEqual(x.contextTransactions,[]);assert.deepEqual(x.reimbursementLinks,[]);
    const byDateId=(u,v)=>u.date.localeCompare(v.date)||Buffer.compare(Buffer.from(u.id),Buffer.from(v.id));
    const order=[{date:'2026-11-01',id:pfExpense},{date:'2026-11-02',id:pfRevenue},{date:'2026-11-02',id:pjRevenue},
      {date:'2026-11-03',id:transfer},{date:'2026-11-04',id:pjExpense}].sort(byDateId).map(v=>v.id);
    assert.deepEqual(x.transactions.map(v=>v.transactionId),order);
    assert.ok(!JSON.stringify(x).includes(foreignTx));assert.ok(!JSON.stringify(x).includes('Contexto'));assert.ok(!JSON.stringify(x).includes('Excluída'));
    const first=x.transactions[0];assert.deepEqual(Object.keys(first).sort(),['transactionId','accountId','accountName','accountType','occurredOn','direction','amountCents','descriptionOriginal','categoryOriginal','classification','isPfBusinessExpense','explanationOriginal','sourceType','sourceCode','externalId','documentIds','reimbursementStatus'].sort());
    assert.equal(first.occurredOn,'2026-11-01');assert.equal(first.accountType,'PF');assert.equal(first.reimbursementStatus,'PENDENTE_REEMBOLSO');assert.deepEqual(first.documentIds,[doc]);
    assert.deepEqual(x.transactions.find(v=>v.transactionId===pjExpense).documentIds,[doc]);assert.equal(x.transactions.find(v=>v.transactionId===pfRevenue).reimbursementStatus,'NAO_APLICAVEL');
    assert.deepEqual(x.pendingItems.map(p=>p.pendingId),[p1,p3,p2]);
    for(const item of x.pendingItems)assert.deepEqual(Object.keys(item).sort(),['pendingId','transactionId','pendingType','status','description','justification'].sort());
    assert.deepEqual(x.pendingItems.map(p=>[p.transactionId,p.pendingType,p.status,p.description,p.justification]),[
      [pfExpense,'DOCUMENTO_AUSENTE','RESOLVIDA','Synthetic pending',''],[pjExpense,'DUVIDA_CADASTRADA','JUSTIFICADA','Synthetic pending','Synthetic reason'],
      [pfExpense,'REEMBOLSO_PF_PENDENTE','PENDENTE','Synthetic pending','']]);
    assert.deepEqual(x.summary,{cashFlowByAccount:[
      {accountId:pf,accountName:'Synthetic PF',accountType:'PF',inflowCents:120,outflowCents:100,netCents:20},
      {accountId:pj,accountName:'Synthetic PJ',accountType:'PJ',inflowCents:500,outflowCents:120,netCents:380}].sort((u,v)=>u.accountId.localeCompare(v.accountId)),
      businessRevenueTotalCents:500,businessExpenseTotalCents:170,reimbursementsSettledInPeriodCents:0,pendingCount:1,justifiedCount:1,
      categoryTotals:[{category:'z',inflowCents:0,outflowCents:50,netCents:-50},{category:'Água',inflowCents:500,outflowCents:70,netCents:430},
        {category:'Ética',inflowCents:120,outflowCents:100,netCents:20}]});
    assert.deepEqual(await counts(),before);assert.equal(await revision(),rev);
    for(const event of logs)assert.deepEqual(Object.keys(event).sort(),['durationMs','operation','requestId','status']);
  });
  await t.test('1000 principal movements accepted and 1001 rejected without truncation or writes',async()=>{
    const limitOwner=await owner('Synthetic I06 limit'),id=await account(limitOwner,'PF','Limit PF');
    await admin.query('INSERT INTO mimir.periods(id,workspace_id,period_month) VALUES($1,$2,$3)',[randomUUID(),limitOwner.workspaceId,'2026-12']);
    await admin.query(`INSERT INTO mimir.transactions(id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,description,category,classification,is_pf_business_expense,explanation,source_type,source_code,external_id)
      SELECT md5($1::text || g::text)::uuid,$1::uuid,$2::uuid,DATE '2026-12-01','2026-12','SAIDA',1,'Synthetic limit','LIMITE','TRANSFERENCIA',false,'','MANUAL','MANUAL',g::text
      FROM generate_series(1,1000) g`,[limitOwner.workspaceId,id]);
    const r=await get('2026-12',limitOwner);assert.equal(r.status,200);const x=await r.json();assert.equal(x.transactions.length,1000);assert.equal(x.summary.categoryTotals[0].outflowCents,1000);
    await admin.query(`INSERT INTO mimir.transactions(id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,description,category,classification,is_pf_business_expense,explanation,source_type,source_code,external_id)
      VALUES($1,$2,$3,'2026-12-01','2026-12','SAIDA',1,'Synthetic overflow','LIMITE','TRANSFERENCIA',false,'','MANUAL','MANUAL','overflow')`,[randomUUID(),limitOwner.workspaceId,id]);
    const before=await counts(limitOwner),rev=await revision(limitOwner),overflow=await get('2026-12',limitOwner);assert.equal(overflow.status,413);
    assert.deepEqual(await counts(limitOwner),before);assert.equal(await revision(limitOwner),rev);
  });
  await t.test('1000 distinct document references accepted and 1001 rejected without truncation',async()=>{
    const who=await owner('Synthetic I06 document limit'),id=await account(who,'PF','Doc PF'),tx=await add(who,id,{classification:'TRANSFERENCIA'});
    await admin.query(`INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes)
      SELECT md5($1::text || g::text)::uuid,$1::uuid,'synthetic.pdf','application/pdf',1,encode(sha256(decode('25','hex')),'hex'),decode('25','hex')
      FROM generate_series(1,1000) g`,[who.workspaceId]);
    await admin.query(`INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id)
      SELECT $1::uuid,$2::uuid,md5($1::text || g::text)::uuid FROM generate_series(1,1000) g`,[who.workspaceId,tx]);
    const valid=await get('2026-11',who);assert.equal(valid.status,200);assert.equal((await valid.json()).transactions[0].documentIds.length,1000);
    const over=randomUUID();await admin.query(`INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes)
      VALUES($1,$2,'synthetic.pdf','application/pdf',1,$3,$4)`,[over,who.workspaceId,createHash('sha256').update(Buffer.from('%')).digest('hex'),Buffer.from('%')]);
    await admin.query('INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id) VALUES($1,$2,$3)',[who.workspaceId,tx,over]);
    const before=await counts(who),rev=await revision(who),invalid=await get('2026-11',who);assert.equal(invalid.status,413);
    assert.deepEqual(await counts(who),before);assert.equal(await revision(who),rev);
  });
  await t.test('unique attachment bytes cap is inclusive at 100 MiB',async()=>{
    const who=await owner('Synthetic I06 byte limit'),id=await account(who,'PF','Bytes PF'),tx=await add(who,id,{classification:'TRANSFERENCIA'});
    const fiveMiB=Buffer.alloc(5*1024*1024,0x25),hash=createHash('sha256').update(fiveMiB).digest('hex');
    for(let i=0;i<20;i++){
      const docId=randomUUID();await admin.query(`INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes)
        VALUES($1,$2,'synthetic.pdf','application/pdf',$3,$4,$5)`,[docId,who.workspaceId,fiveMiB.length,hash,fiveMiB]);
      await admin.query('INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id) VALUES($1,$2,$3)',[who.workspaceId,tx,docId]);
    }
    const atLimit=await get('2026-11',who);assert.equal(atLimit.status,200);assert.equal((await atLimit.json()).transactions[0].documentIds.length,20);
    const extra=randomUUID(),one=Buffer.from('%');await admin.query(`INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes)
      VALUES($1,$2,'synthetic.pdf','application/pdf',1,$3,$4)`,[extra,who.workspaceId,createHash('sha256').update(one).digest('hex'),one]);
    await admin.query('INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id) VALUES($1,$2,$3)',[who.workspaceId,tx,extra]);
    assert.equal((await get('2026-11',who)).status,413);
  });
  await t.test('10000 document associations accepted and 10001 rejected',async()=>{
    const who=await owner('Synthetic I06 association limit'),id=await account(who,'PF','Associations PF');
    await admin.query('INSERT INTO mimir.periods(id,workspace_id,period_month) VALUES($1,$2,$3)',[randomUUID(),who.workspaceId,'2027-01']);
    await admin.query(`INSERT INTO mimir.transactions(id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,description,category,classification,is_pf_business_expense,explanation,source_type,source_code,external_id)
      SELECT md5($1::text || g::text)::uuid,$1::uuid,$2::uuid,DATE '2027-01-01','2027-01','SAIDA',1,'Synthetic associations','LIMITE','TRANSFERENCIA',false,'','MANUAL','MANUAL',g::text
      FROM generate_series(1,1000) g`,[who.workspaceId,id]);
    await admin.query(`INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes)
      SELECT md5('doc' || $1::text || g::text)::uuid,$1::uuid,'synthetic.pdf','application/pdf',1,encode(sha256(decode('25','hex')),'hex'),decode('25','hex')
      FROM generate_series(1,11) g`,[who.workspaceId]);
    await admin.query(`INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id)
      SELECT $1::uuid,md5($1::text || tx::text)::uuid,md5('doc' || $1::text || doc::text)::uuid
      FROM generate_series(1,1000) tx CROSS JOIN generate_series(1,10) doc`,[who.workspaceId]);
    const accepted=await get('2027-01',who);assert.equal(accepted.status,200);assert.equal((await accepted.json()).transactions.length,1000);
    await admin.query(`INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id)
      VALUES($1::uuid,md5($1::text || '1')::uuid,md5('doc' || $1::text || '11')::uuid)`,[who.workspaceId]);
    assert.equal((await get('2027-01',who)).status,413);
  });
  await t.test('transaction selection is executed in PostgreSQL repeatable read and read only',async()=>{
    let allow=false,restrict=false,enabled=false;
    try{
      await admin.query('CREATE POLICY i06_preview_allow ON mimir.transactions FOR ALL TO mimir_runtime USING (true) WITH CHECK (true)');allow=true;
      await admin.query(`CREATE POLICY i06_preview_mode ON mimir.transactions AS RESTRICTIVE FOR SELECT TO mimir_runtime
        USING (workspace_id <> '${a.workspaceId}'::uuid OR
          (current_setting('transaction_read_only')='on' AND current_setting('transaction_isolation')='repeatable read'))`);restrict=true;
      await admin.query('ALTER TABLE mimir.transactions ENABLE ROW LEVEL SECURITY');enabled=true;
      const r=await get();assert.equal(r.status,200);assert.equal((await r.json()).transactions.length,5);
    }finally{
      if(enabled)await admin.query('ALTER TABLE mimir.transactions DISABLE ROW LEVEL SECURITY');
      if(restrict)await admin.query('DROP POLICY i06_preview_mode ON mimir.transactions');
      if(allow)await admin.query('DROP POLICY i06_preview_allow ON mimir.transactions');
    }
  });
  await t.test('revision and rows derive from one repeatable-read snapshot under concurrent commit',async()=>{
    const old=await revision(),blocker=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL}),observer=new pg.Client({connectionString:process.env.PROVISION_DATABASE_URL});
    await blocker.connect();await observer.connect();let open=false,promise;
    try{
      await blocker.query('BEGIN');open=true;await blocker.query('LOCK TABLE mimir.transactions IN ACCESS EXCLUSIVE MODE');
      promise=get();let blocked=false;
      for(let i=0;i<100;i++){
        blocked=(await observer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='mimir-preview' AND wait_event_type='Lock') AS blocked")).rows[0].blocked;
        if(blocked)break;await new Promise(r=>setTimeout(r,10));
      }
      assert.ok(blocked,'preview SELECT must wait after its workspace snapshot');
      await blocker.query('UPDATE mimir.workspaces SET revision=revision+1 WHERE id=$1',[a.workspaceId]);
      await blocker.query("UPDATE mimir.transactions SET amount_cents=901 WHERE id=$1",[pfExpense]);
      await blocker.query('COMMIT');open=false;
      const response=await promise;assert.equal(response.status,200);const x=await response.json();
      assert.equal(x.revision,old);assert.equal(x.transactions.find(v=>v.transactionId===pfExpense).amountCents,100);
      const next=await get();assert.equal(next.status,200);const y=await next.json();assert.equal(y.revision,old+1);assert.equal(y.transactions.find(v=>v.transactionId===pfExpense).amountCents,901);
    }finally{if(open)await blocker.query('ROLLBACK');await promise?.catch(()=>{});await blocker.end();await observer.end();}
  });
});
