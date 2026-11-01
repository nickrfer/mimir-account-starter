import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createOwner } from '../../tools/admin/owners.mjs';
import { PostgresAuthentication } from '../../apps/api/dist/adapters/postgres-auth.js';
import { PostgresPersistence } from '../../apps/api/dist/adapters/postgres.js';
import { AuthenticationService,sessionHash } from '../../apps/api/dist/auth/service.js';
import { createApp } from '../../apps/api/dist/server.js';

test('I03 accounts: PostgreSQL and HTTP real',async t=>{
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  const url=new URL(process.env.MIGRATION_DATABASE_URL);url.username='mimir_runtime';url.password=process.env.APP_ROLE_PASSWORD;
  const auth=new PostgresAuthentication(url.toString()),persistence=new PostgresPersistence(url.toString());
  const module=await import('../../apps/api/dist/adapters/postgres-accounts.js').catch(()=>null);
  const accounts=module?new module.PostgresAccounts(url.toString()):undefined;
  const service=await AuthenticationService.create(auth),logs=[],origin='http://127.0.0.1:3000';
  const server=createApp(persistence,fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),
    {service,origins:new Set([origin]),allowLocalHttp:true,log:event=>logs.push(event)},accounts);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await Promise.all([auth.close(),persistence.close(),accounts?.close(),admin.end()]);});
  const password=randomBytes(24).toString('hex');
  async function owner(label){
    const email=`${randomUUID()}@example.invalid`;
    const identity=await createOwner({email,password,displayName:label,companyName:label});
    const response=await fetch(base+'/api/v1/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    assert.equal(response.status,200);
    const token=response.headers.get('set-cookie')?.match(/^mimir_session=([a-f0-9]{64});/)?.[1];assert.ok(token);
    const context=await response.json();
    return{...identity,token,csrf:context.csrfToken};
  }
  const a=await owner('Synthetic A'),b=await owner('Synthetic B');
  const headers=(who=a)=>({Origin:origin,Cookie:`mimir_session=${who.token}`,'X-CSRF-Token':who.csrf,'Content-Type':'application/json'});
  const create=(name,revision,who=a,extra={})=>fetch(base+'/api/v1/accounts',{method:'POST',headers:headers(who),body:JSON.stringify({name,accountType:'PF',expectedRevision:revision,...extra})});
  const list=(query='',who=a)=>fetch(base+'/api/v1/accounts'+query,{headers:headers(who)});
  const revision=async(who=a)=>(await admin.query('SELECT revision::text AS value FROM mimir.workspaces WHERE id=$1',[who.workspaceId])).rows[0].value;
  let firstId;

  await t.test('GET accounts requires authentication',async()=>{
    assert.equal((await fetch(base+'/api/v1/accounts')).status,401);
  });
  await t.test('POST creates normalized account and increments once; GET does not mutate',async()=>{
    const response=await create('  Cafe\u0301  ',1);assert.equal(response.status,201);
    const body=await response.json();firstId=body.account.id;
    assert.deepEqual(Object.keys(body).sort(),['account','revision']);assert.equal(body.revision,2);
    assert.deepEqual(body.account,{id:firstId,name:'Café',accountType:'PF',active:true});
    const read=await list();assert.equal(read.status,200);const page=await read.json();
    assert.deepEqual(page,{items:[body.account],nextCursor:null});assert.equal(await revision(),'2');
  });
  await t.test('stale revisions and duplicate normalized names return 409 without changes',async()=>{
    let response=await create('Fresh',1);assert.equal(response.status,409);assert.equal((await response.json()).code,'REVISION_CONFLICT');
    response=await create('  CAFE\u0301 ',2);assert.equal(response.status,409);assert.equal((await response.json()).code,'ACCOUNT_NAME_CONFLICT');
    assert.equal(await revision(),'2');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM mimir.accounts WHERE workspace_id=$1',[a.workspaceId])).rows[0].n,1);
  });
  await t.test('owner isolation permits same name in another workspace and rejects foreign cursors uniformly',async()=>{
    const response=await create('Café',1,b);assert.equal(response.status,201);const foreign=(await response.json()).account.id;
    const page=await(await list('',b)).json();assert.equal(page.items.length,1);assert.equal(page.items[0].id,foreign);
    assert.equal((await(await list()).json()).items.length,1);
    for(const id of [foreign,randomUUID()]){
      const denied=await list(`?cursor=${id}`);assert.equal(denied.status,404);assert.equal((await denied.json()).code,'NOT_FOUND');
    }
    assert.equal((await list(`?workspaceId=${b.workspaceId}`)).status,400);
    assert.equal((await create('Foreign',2,a,{workspaceId:b.workspaceId})).status,422);
    assert.equal(await revision(b),'2');assert.equal(await revision(),'2');
  });
  await t.test('CSRF Origin cookies and malformed bodies are rejected before a mutation',async()=>{
    const body=JSON.stringify({name:'Forbidden',accountType:'PF',expectedRevision:2});
    const post=extra=>fetch(base+'/api/v1/accounts',{method:'POST',headers:{...headers(),...extra},body});
    assert.equal((await post({'X-CSRF-Token':''})).status,403);
    assert.equal((await post({Origin:'http://evil.example.invalid'})).status,403);
    assert.equal((await post({Cookie:`mimir_session=${a.token}; mimir_session=${a.token}`})).status,401);
    assert.equal((await post({'Content-Type':'text/plain'})).status,415);
    assert.equal((await fetch(base+'/api/v1/accounts',{method:'POST',headers:headers(),body:'{'})).status,400);
    assert.equal((await fetch(base+'/api/v1/accounts',{method:'POST',headers:headers(),body:'x'.repeat(9000)})).status,413);
    for(const extra of [{ownerId:b.userId},{expectedRevision:2.5},{name:' '},{name:'\u0344'.repeat(200)},{accountType:{toString:null}},{active:false}])
      assert.equal((await create('Invalid',2,a,extra)).status,422);
    assert.equal(await revision(),'2');
  });
  await t.test('PJ and expanded Unicode name key remain valid under the public 200-character contract',async()=>{
    const response=await create('İ'.repeat(200),2,a,{accountType:'PJ'});assert.equal(response.status,201);
    const body=await response.json();assert.equal(body.revision,3);assert.equal(body.account.accountType,'PJ');
    const row=(await admin.query('SELECT name_key FROM mimir.accounts WHERE id=$1',[body.account.id])).rows[0];assert.equal([...row.name_key].length,400);
    assert.equal((await create('İ'.repeat(201),3)).status,422);assert.equal(await revision(),'3');
  });
  await t.test('two concurrent commands with the same revision produce one account and one increment',async()=>{
    const before=(await admin.query('SELECT count(*)::int AS n FROM mimir.accounts WHERE workspace_id=$1',[a.workspaceId])).rows[0].n;
    const responses=await Promise.all([create('Concurrent A',3),create('Concurrent B',3)]);
    assert.deepEqual(responses.map(response=>response.status).sort(),[201,409]);
    assert.equal(await revision(),'4');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM mimir.accounts WHERE workspace_id=$1',[a.workspaceId])).rows[0].n,before+1);
  });
  await t.test('failure after INSERT rolls back both account and revision and sanitizes error',async()=>{
    await admin.query(`CREATE FUNCTION mimir.reject_i03_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.company_name='Synthetic A' THEN RAISE EXCEPTION 'synthetic revision failure'; END IF; RETURN NEW; END $$`);
    await admin.query('CREATE TRIGGER reject_i03_revision BEFORE UPDATE ON mimir.workspaces FOR EACH ROW EXECUTE FUNCTION mimir.reject_i03_revision()');
    try{
      const response=await create('Must roll back',4);assert.equal(response.status,500);
      const error=await response.json();assert.deepEqual(Object.keys(error).sort(),['code','message','requestId']);assert.equal(error.code,'INTERNAL_ERROR');
      assert.equal((await admin.query('SELECT 1 FROM mimir.accounts WHERE workspace_id=$1 AND name=$2',[a.workspaceId,'Must roll back'])).rowCount,0);
      assert.equal(await revision(),'4');
    }finally{await admin.query('DROP TRIGGER reject_i03_revision ON mimir.workspaces');await admin.query('DROP FUNCTION mimir.reject_i03_revision()');}
  });
  await t.test('safe integer revision exhaustion rejects before inserting',async()=>{
    await admin.query('UPDATE mimir.workspaces SET revision=9007199254740991 WHERE id=$1',[b.workspaceId]);
    try{
      const response=await create('No overflow',9007199254740991,b);assert.equal(response.status,409);assert.equal((await response.json()).code,'REVISION_EXHAUSTED');
      assert.equal(await revision(b),'9007199254740991');
      assert.equal((await admin.query('SELECT 1 FROM mimir.accounts WHERE workspace_id=$1 AND name=$2',[b.workspaceId,'No overflow'])).rowCount,0);
    }finally{await admin.query('UPDATE mimir.workspaces SET revision=2 WHERE id=$1',[b.workspaceId]);}
  });
  await t.test('pagination is bounded stable scoped and read-only, including inactive accounts',async()=>{
    await admin.query(`INSERT INTO mimir.accounts(id,workspace_id,name,name_key,account_type)
      SELECT gen_random_uuid(),$1,'Synthetic page '||n,'synthetic page '||n,'PJ' FROM generate_series(1,205) n`,[a.workspaceId]);
    await admin.query('UPDATE mimir.accounts SET active=false WHERE workspace_id=$1 AND id=$2',[a.workspaceId,firstId]);
    const seen=[];let cursor=null,inactiveSeen=false;
    do{
      const page=await(await list(`?limit=17${cursor?'&cursor='+cursor:''}`)).json();
      assert.ok(page.items.length<=17);assert.deepEqual(Object.keys(page).sort(),['items','nextCursor']);
      for(const item of page.items){assert.deepEqual(Object.keys(item).sort(),['accountType','active','id','name']);seen.push(item.id);if(item.id===firstId){assert.equal(item.active,false);inactiveSeen=true;}}
      cursor=page.nextCursor;
    }while(cursor);
    const expected=(await admin.query('SELECT id FROM mimir.accounts WHERE workspace_id=$1 ORDER BY id',[a.workspaceId])).rows.map(row=>row.id);
    assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,seen.length);
    const initial=await(await list()).json();assert.equal(initial.items.length,100);assert.ok(initial.nextCursor);
    const max=await(await list('?limit=200')).json();assert.equal(max.items.length,200);assert.ok(max.nextCursor);
    assert.ok(inactiveSeen,'inactive account must remain visible with its actual flag');
    for(const query of ['?limit=201','?limit=0','?limit=1e2','?limit=1&limit=2','?cursor=bad','?cursor='])assert.equal((await list(query)).status,400);
    assert.equal(await revision(),'4');
  });
  for(const state of ['revoked','expired'])await t.test(`session ${state} while waiting for workspace lock cannot mutate`,async()=>{
    assert.ok(accounts,'I03 persistence missing');
    const actor=await owner('Blocked '+state);
    const supervisor=new pg.Client({connectionString:process.env.PROVISION_DATABASE_URL});await supervisor.connect();
    await admin.query('BEGIN');await admin.query('SELECT id FROM mimir.workspaces WHERE id=$1 FOR UPDATE',[actor.workspaceId]);
    const pending=create('Blocked '+state,1,actor);
    let open=true;
    try{
      let observed=false;
      for(let i=0;i<70;i++){
        observed=(await supervisor.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='mimir-accounts' AND wait_event_type='Lock') AS blocked")).rows[0].blocked;
        if(observed)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.ok(observed,'request must actually wait on the DB workspace lock');
      if(state==='revoked')await admin.query('UPDATE mimir.sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[sessionHash(actor.token)]);
      else await admin.query("UPDATE mimir.sessions SET created_at=clock_timestamp()-interval '9 hours',expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[sessionHash(actor.token)]);
      await admin.query('COMMIT');open=false;
      const response=await pending;assert.equal(response.status,401);assert.equal(await revision(actor),'1');
      assert.equal((await admin.query('SELECT 1 FROM mimir.accounts WHERE workspace_id=$1',[actor.workspaceId])).rowCount,0);
    }finally{if(open)await admin.query('ROLLBACK');await pending.catch(()=>{});await supervisor.end();}
  });
  await t.test('actor mismatch is rejected by persistence and logs contain no names or credentials',async()=>{
    assert.ok(accounts,'I03 persistence missing');
    await assert.rejects(accounts.list({userId:a.userId,workspaceId:b.workspaceId,tokenHash:sessionHash(a.token)},{limit:100,cursor:null}),error=>error.status===401);
    for(const event of logs)assert.deepEqual(Object.keys(event).sort(),['durationMs','operation','requestId','status']);
    const encoded=JSON.stringify(logs);assert.ok(![password,a.token,a.csrf,'Café','Concurrent A'].some(value=>encoded.includes(value)));
  });
});
