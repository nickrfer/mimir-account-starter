import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createOwner } from '../../tools/admin/owners.mjs';
import { PostgresAuthentication } from '../../apps/api/dist/adapters/postgres-auth.js';
import { PostgresPersistence } from '../../apps/api/dist/adapters/postgres.js';
import { PostgresAccounts } from '../../apps/api/dist/adapters/postgres-accounts.js';
import { AuthenticationService,sessionHash } from '../../apps/api/dist/auth/service.js';
import { createApp } from '../../apps/api/dist/server.js';

test('I04 manual transactions: PostgreSQL and HTTP real',async t=>{
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  const url=new URL(process.env.MIGRATION_DATABASE_URL);url.username='mimir_runtime';url.password=process.env.APP_ROLE_PASSWORD;
  const auth=new PostgresAuthentication(url.toString()),persistence=new PostgresPersistence(url.toString()),accounts=new PostgresAccounts(url.toString());
  const module=await import('../../apps/api/dist/adapters/postgres-transactions.js').catch(()=>null);
  const transactions=module?new module.PostgresTransactions(url.toString()):undefined;
  const service=await AuthenticationService.create(auth),logs=[],origin='http://127.0.0.1:3000';
  const server=createApp(persistence,fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),
    {service,origins:new Set([origin]),allowLocalHttp:true,log:event=>logs.push(event)},accounts,transactions);
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await Promise.all([auth.close(),persistence.close(),accounts.close(),transactions?.close(),admin.end()]);});
  const password=randomBytes(24).toString('hex');
  async function owner(label){
    const email=`${randomUUID()}@example.invalid`,identity=await createOwner({email,password,displayName:label,companyName:label});
    const response=await fetch(base+'/api/v1/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(response.status,200);
    const token=response.headers.get('set-cookie')?.match(/^mimir_session=([a-f0-9]{64});/)?.[1];assert.ok(token);
    return{...identity,token,csrf:(await response.json()).csrfToken};
  }
  const a=await owner('Synthetic I04 A'),b=await owner('Synthetic I04 B');
  const headers=(who=a)=>({Origin:origin,Cookie:`mimir_session=${who.token}`,'X-CSRF-Token':who.csrf,'Content-Type':'application/json'});
  async function account(type,revision,who=a){const response=await fetch(base+'/api/v1/accounts',{method:'POST',headers:headers(who),body:JSON.stringify({name:'Synthetic '+type,accountType:type,expectedRevision:revision})});assert.equal(response.status,201);return(await response.json()).account.id;}
  const pf=await account('PF',1),pj=await account('PJ',2),foreign=await account('PF',1,b);
  const command={accountId:pf,occurredOn:'2026-10-12',direction:'SAIDA',amountCents:1250,description:'Synthetic I04',category:'Geral',classification:'DESPESA',isPfBusinessExpense:false,explanation:'',expectedRevision:3};
  const create=(extra={},who=a,extraHeaders={})=>fetch(base+'/api/v1/transactions',{method:'POST',headers:{...headers(who),...extraHeaders},body:JSON.stringify({...command,...extra})});
  const revision=async(who=a)=>(await admin.query('SELECT revision::text AS n FROM mimir.workspaces WHERE id=$1',[who.workspaceId])).rows[0].n;
  const counts=async(who=a)=>(await admin.query(`SELECT
    (SELECT count(*)::int FROM mimir.periods WHERE workspace_id=$1) AS periods,
    (SELECT count(*)::int FROM mimir.transactions WHERE workspace_id=$1) AS transactions,
    (SELECT count(*)::int FROM mimir.pending_items WHERE workspace_id=$1) AS pending`,[who.workspaceId])).rows[0];
  const currentCreate=async(extra={},who=a)=>create({...extra,expectedRevision:Number(await revision(who))},who);
  let firstId;
  await t.test('POST creates manual transaction period pending and revision in one commit',async()=>{
    const response=await create();assert.equal(response.status,201);const body=await response.json();firstId=body.transaction.transactionId;
    assert.deepEqual(Object.keys(body).sort(),['revision','transaction']);assert.equal(body.revision,4);
    assert.deepEqual(body.transaction,{transactionId:firstId,accountId:pf,accountName:'Synthetic PF',accountType:'PF',occurredOn:'2026-10-12',direction:'SAIDA',amountCents:1250,
      descriptionOriginal:'Synthetic I04',categoryOriginal:'Geral',classification:'DESPESA',isPfBusinessExpense:false,explanationOriginal:'',sourceType:'MANUAL',sourceCode:'MANUAL',externalId:firstId,documentIds:[],reimbursementStatus:'NAO_APLICAVEL'});
    const row=(await admin.query('SELECT period_month,source_type,source_code,external_id FROM mimir.transactions WHERE workspace_id=$1 AND id=$2',[a.workspaceId,firstId])).rows[0];
    assert.deepEqual(row,{period_month:'2026-10',source_type:'MANUAL',source_code:'MANUAL',external_id:firstId});
    const pending=(await admin.query('SELECT type,status,justification FROM mimir.pending_items WHERE workspace_id=$1 AND transaction_id=$2',[a.workspaceId,firstId])).rows;
    assert.deepEqual(pending,[{type:'DOCUMENTO_AUSENTE',status:'PENDENTE',justification:''}]);assert.equal(await revision(),'4');
  });
  await t.test('valid maximum Unicode text fields fit the HTTP transport limit',async()=>{
    const response=await currentCreate({description:'😀'.repeat(500),category:'😀'.repeat(100),explanation:'😀'.repeat(2000)});assert.equal(response.status,201);
    const tx=(await response.json()).transaction;
    assert.equal([...tx.descriptionOriginal].length,500);assert.equal([...tx.categoryOriginal].length,100);assert.equal([...tx.explanationOriginal].length,2000);
  });
  await t.test('PF receipt is allowed, preserves civil date and exact maximum cents without business flag',async()=>{
    const response=await currentCreate({direction:'ENTRADA',classification:'RECEITA',amountCents:99999999999,occurredOn:'2024-02-29'});assert.equal(response.status,201);
    const tx=(await response.json()).transaction;assert.equal(tx.accountType,'PF');assert.equal(tx.isPfBusinessExpense,false);assert.equal(tx.amountCents,99999999999);assert.equal(tx.occurredOn,'2024-02-29');
    assert.equal(tx.reimbursementStatus,'NAO_APLICAVEL');
    const row=(await admin.query('SELECT amount_cents::text,occurred_on::text,period_month FROM mimir.transactions WHERE id=$1',[tx.transactionId])).rows[0];
    assert.deepEqual(row,{amount_cents:'99999999999',occurred_on:'2024-02-29',period_month:'2024-02'});
  });
  await t.test('PF business expense creates two pending items; explanation is not justification',async()=>{
    const response=await currentCreate({isPfBusinessExpense:true,explanation:'  Synthetic explanation  '});assert.equal(response.status,201);const body=await response.json();
    assert.equal(body.transaction.reimbursementStatus,'PENDENTE_REEMBOLSO');assert.equal(body.transaction.explanationOriginal,'Synthetic explanation');
    const rows=(await admin.query('SELECT type,status,justification FROM mimir.pending_items WHERE workspace_id=$1 AND transaction_id=$2 ORDER BY type',[a.workspaceId,body.transaction.transactionId])).rows;
    assert.deepEqual(rows,[{type:'DOCUMENTO_AUSENTE',status:'PENDENTE',justification:''},{type:'REEMBOLSO_PF_PENDENTE',status:'PENDENTE',justification:''}]);
  });
  await t.test('PJ receipts/expenses and either transfer direction create the correct initial pending set',async()=>{
    for(const [classification,direction,types] of [['RECEITA','ENTRADA',['DOCUMENTO_AUSENTE']],['DESPESA','SAIDA',['DOCUMENTO_AUSENTE']],
      ['TRANSFERENCIA','ENTRADA',[]],['TRANSFERENCIA','SAIDA',[]],['A_ESCLARECER','ENTRADA',['CLASSIFICACAO_A_ESCLARECER']],['A_ESCLARECER','SAIDA',['CLASSIFICACAO_A_ESCLARECER']]]){
      const response=await currentCreate({accountId:pj,classification,direction});assert.equal(response.status,201);const tx=(await response.json()).transaction;
      assert.equal(tx.accountType,'PJ');assert.equal(tx.reimbursementStatus,'NAO_APLICAVEL');assert.deepEqual(tx.documentIds,[]);
      const rows=(await admin.query('SELECT type FROM mimir.pending_items WHERE workspace_id=$1 AND transaction_id=$2 ORDER BY type',[a.workspaceId,tx.transactionId])).rows;
      assert.deepEqual(rows.map(row=>row.type),types);
    }
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM mimir.periods WHERE workspace_id=$1 AND period_month='2026-10'",[a.workspaceId])).rows[0].n,1);
  });
  await t.test('foreign and nonexistent accounts are indistinguishable, inactive and PJ business flags are rejected',async()=>{
    const before=await counts(),rev=await revision();
    for(const id of [foreign,randomUUID()]){const response=await create({accountId:id,expectedRevision:Number(rev)-1});assert.equal(response.status,404);assert.equal((await response.json()).code,'NOT_FOUND');}
    const invalidFlag=await currentCreate({accountId:pj,isPfBusinessExpense:true});assert.equal(invalidFlag.status,422);
    await admin.query('UPDATE mimir.accounts SET active=false WHERE id=$1',[pf]);
    try{const response=await currentCreate();assert.equal(response.status,409);assert.equal((await response.json()).code,'ACCOUNT_INACTIVE');}
    finally{await admin.query('UPDATE mimir.accounts SET active=true WHERE id=$1',[pf]);}
    assert.deepEqual(await counts(),before);assert.equal(await revision(),rev);
  });
  await t.test('authentication Origin CSRF query and invalid commands do not create any aggregate',async()=>{
    const before=await counts(),rev=await revision();
    assert.equal((await create({},a,{Cookie:''})).status,401);
    assert.equal((await create({},a,{'X-CSRF-Token':''})).status,403);
    assert.equal((await create({},a,{Origin:'http://evil.example.invalid'})).status,403);
    assert.equal((await create({},a,{Cookie:`mimir_session=${a.token}; mimir_session=${a.token}`})).status,401);
    assert.equal((await create({},a,{'Content-Type':'text/plain'})).status,415);
    for(const extra of [{amountCents:0},{amountCents:1.5},{amountCents:'1'},{occurredOn:'2023-02-29'},{description:'\u0344'.repeat(300)},
      {classification:'RECEITA',direction:'SAIDA'},{isPfBusinessExpense:'true'},{classification:{toString:null}},{workspaceId:b.workspaceId},{sourceCode:'CSV'},{periodMonth:'2026-10'}])
      assert.equal((await currentCreate(extra)).status,422);
    assert.equal((await fetch(base+'/api/v1/transactions?workspaceId='+b.workspaceId,{method:'POST',headers:headers(),body:JSON.stringify(command)})).status,400);
    assert.equal((await fetch(base+'/api/v1/transactions',{method:'POST',headers:headers(),body:'{'})).status,400);
    assert.equal((await fetch(base+'/api/v1/transactions',{method:'POST',headers:headers(),body:'x'.repeat(33000)})).status,413);
    assert.deepEqual(await counts(),before);assert.equal(await revision(),rev);
  });
  await t.test('stale and repeated commands reject before creating a second record or period',async()=>{
    const before=await counts(),rev=await revision();
    const response=await create({occurredOn:'2030-01-02',expectedRevision:Number(rev)-1});assert.equal(response.status,409);assert.equal((await response.json()).code,'REVISION_CONFLICT');
    assert.deepEqual(await counts(),before);assert.equal(await revision(),rev);
  });
  await t.test('two concurrent commands produce exactly one transaction pending item and revision increment',async()=>{
    const before=await counts(),rev=Number(await revision());
    const responses=await Promise.all([create({occurredOn:'2030-01-02',expectedRevision:rev}),create({occurredOn:'2030-01-03',expectedRevision:rev})]);
    assert.deepEqual(responses.map(response=>response.status).sort(),[201,409]);
    assert.equal(await revision(),String(rev+1));const after=await counts();assert.equal(after.transactions,before.transactions+1);assert.equal(after.pending,before.pending+1);assert.equal(after.periods,before.periods+1);
  });
  for(const fault of ['pending','revision'])await t.test(`failure in ${fault} rolls back new period transaction all pending rows and revision`,async()=>{
    const before=await counts(),rev=await revision();
    if(fault==='pending'){
      await admin.query(`CREATE FUNCTION mimir.reject_i04_pending() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type='REEMBOLSO_PF_PENDENTE' AND (SELECT company_name FROM mimir.workspaces WHERE id=NEW.workspace_id)='Synthetic I04 A'
        THEN RAISE EXCEPTION 'synthetic pending failure'; END IF; RETURN NEW; END $$`);
      await admin.query('CREATE TRIGGER reject_i04_pending BEFORE INSERT ON mimir.pending_items FOR EACH ROW EXECUTE FUNCTION mimir.reject_i04_pending()');
    }else{
      await admin.query(`CREATE FUNCTION mimir.reject_i04_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.company_name='Synthetic I04 A' THEN RAISE EXCEPTION 'synthetic revision failure'; END IF; RETURN NEW; END $$`);
      await admin.query('CREATE TRIGGER reject_i04_revision BEFORE UPDATE ON mimir.workspaces FOR EACH ROW EXECUTE FUNCTION mimir.reject_i04_revision()');
    }
    try{
      const response=await currentCreate({occurredOn:'2031-09-12',isPfBusinessExpense:true});assert.equal(response.status,500);
      const error=await response.json();assert.equal(error.code,'INTERNAL_ERROR');assert.deepEqual(Object.keys(error).sort(),['code','message','requestId']);
      assert.deepEqual(await counts(),before);assert.equal(await revision(),rev);
      assert.equal((await admin.query("SELECT 1 FROM mimir.periods WHERE workspace_id=$1 AND period_month='2031-09'",[a.workspaceId])).rowCount,0);
    }finally{
      const table=fault==='pending'?'pending_items':'workspaces';
      await admin.query(`DROP TRIGGER reject_i04_${fault} ON mimir.${table}`);await admin.query(`DROP FUNCTION mimir.reject_i04_${fault}()`);
    }
  });
  await t.test('revision overflow and forged persistence actor cannot create a record',async()=>{
    await admin.query('UPDATE mimir.workspaces SET revision=9007199254740991 WHERE id=$1',[b.workspaceId]);
    try{const response=await create({accountId:foreign,expectedRevision:9007199254740991},b);assert.equal(response.status,409);assert.equal((await response.json()).code,'REVISION_EXHAUSTED');assert.equal((await counts(b)).transactions,0);}
    finally{await admin.query('UPDATE mimir.workspaces SET revision=2 WHERE id=$1',[b.workspaceId]);}
    assert.ok(transactions,'I04 persistence missing');
    await assert.rejects(transactions.create({userId:a.userId,workspaceId:b.workspaceId,tokenHash:sessionHash(a.token)},{...command,periodMonth:'2026-10'}),error=>error.status===401);
  });
  await t.test('pending composite FK uniqueness and least privileges are enforced in PostgreSQL',async()=>{
    const runtime=new pg.Client({connectionString:url.toString()});await runtime.connect();
    try{
      const insert=(workspace,type,extra='')=>runtime.query(`INSERT INTO mimir.pending_items(id,workspace_id,transaction_id,type,description${extra?',status':''}) VALUES($1,$2,$3,$4,'Synthetic'${extra?',$5':''})`,
        [randomUUID(),workspace,firstId,type,...(extra?[extra]:[])]);
      await assert.rejects(insert(b.workspaceId,'DOCUMENTO_AUSENTE'),error=>error.code==='23503');
      await assert.rejects(insert(a.workspaceId,'DOCUMENTO_AUSENTE'),error=>error.code==='23505');
      await assert.rejects(insert(a.workspaceId,'INVALID'),error=>error.code==='23514');
      await assert.rejects(insert(a.workspaceId,'DUVIDA_CADASTRADA','JUSTIFICADA'),error=>error.code==='23514');
      // I05 grants only reconciliation columns; type/content remain protected.
      for(const sql of ["UPDATE mimir.pending_items SET type='DUVIDA_CADASTRADA'",'DELETE FROM mimir.pending_items','TRUNCATE mimir.pending_items'])
        await assert.rejects(runtime.query(sql),error=>error.code==='42501');
      await assert.rejects(admin.query('DELETE FROM mimir.transactions WHERE id=$1',[firstId]),error=>error.code==='23001');
    }finally{await runtime.end();}
  });
  for(const state of ['revoked','expired','inactive','retyped'])await t.test(`account/session ${state} while waiting for lock is revalidated before writing`,async()=>{
    const actor=await owner('Blocked I04 '+state),id=await account('PF',1,actor);
    const supervisor=new pg.Client({connectionString:process.env.PROVISION_DATABASE_URL});await supervisor.connect();
    await admin.query('BEGIN');await admin.query('SELECT id FROM mimir.workspaces WHERE id=$1 FOR UPDATE',[actor.workspaceId]);
    const pending=create({accountId:id,isPfBusinessExpense:true,expectedRevision:2},actor);let open=true;
    try{
      let observed=false;
      for(let i=0;i<70;i++){
        observed=(await supervisor.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='mimir-transactions' AND wait_event_type='Lock') AS blocked")).rows[0].blocked;
        if(observed)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.ok(observed,'request must actually wait on workspace lock');
      if(state==='revoked')await admin.query('UPDATE mimir.sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[sessionHash(actor.token)]);
      else if(state==='expired')await admin.query("UPDATE mimir.sessions SET created_at=clock_timestamp()-interval '9 hours',expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[sessionHash(actor.token)]);
      else if(state==='inactive')await admin.query('UPDATE mimir.accounts SET active=false WHERE id=$1',[id]);
      else await admin.query("UPDATE mimir.accounts SET account_type='PJ' WHERE id=$1",[id]);
      await admin.query('COMMIT');open=false;
      assert.equal((await pending).status,state==='inactive'?409:state==='retyped'?422:401);
      assert.deepEqual(await counts(actor),{periods:0,transactions:0,pending:0});assert.equal(await revision(actor),'2');
    }finally{if(open)await admin.query('ROLLBACK');await pending.catch(()=>{});await supervisor.end();}
  });
  await t.test('session revoked while waiting for an account row also rolls back the aggregate',async()=>{
    const actor=await owner('Blocked I04 account row'),id=await account('PF',1,actor);
    const supervisor=new pg.Client({connectionString:process.env.PROVISION_DATABASE_URL});await supervisor.connect();
    await admin.query('BEGIN');await admin.query('SELECT id FROM mimir.accounts WHERE id=$1 FOR UPDATE',[id]);
    const pending=create({accountId:id,isPfBusinessExpense:true,expectedRevision:2},actor);let open=true;
    try{
      let observed=false;
      for(let i=0;i<70;i++){
        observed=(await supervisor.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='mimir-transactions' AND wait_event_type='Lock') AS blocked")).rows[0].blocked;
        if(observed)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.ok(observed,'request must actually wait on account lock');
      await admin.query('UPDATE mimir.sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[sessionHash(actor.token)]);
      await admin.query('COMMIT');open=false;
      assert.equal((await pending).status,401);assert.deepEqual(await counts(actor),{periods:0,transactions:0,pending:0});assert.equal(await revision(actor),'2');
    }finally{if(open)await admin.query('ROLLBACK');await pending.catch(()=>{});await supervisor.end();}
  });
  await t.test('read-only session and logs do not mutate revision or disclose transaction contents',async()=>{
    const before=await revision();const response=await fetch(base+'/api/v1/session',{headers:headers()});assert.equal(response.status,200);assert.equal((await response.json()).revision,Number(before));
    assert.equal(await revision(),before);
    for(const event of logs)assert.deepEqual(Object.keys(event).sort(),['durationMs','operation','requestId','status']);
    const encoded=JSON.stringify(logs);assert.ok(![password,a.token,a.csrf,'Synthetic I04','Synthetic explanation'].some(value=>encoded.includes(value)));
  });
});
