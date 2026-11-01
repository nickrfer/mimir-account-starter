import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { createOwner } from '../../tools/admin/owners.mjs';
import { PostgresAuthentication } from '../../apps/api/dist/adapters/postgres-auth.js';
import { PostgresPersistence } from '../../apps/api/dist/adapters/postgres.js';
import { AuthenticationService, sessionHash } from '../../apps/api/dist/auth/service.js';
import { createApp } from '../../apps/api/dist/server.js';

test('I02 PostgreSQL and HTTP real', async t => {
  const admin = new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});
  await admin.connect();
  const url=new URL(process.env.MIGRATION_DATABASE_URL); url.username='mimir_runtime'; url.password=process.env.APP_ROLE_PASSWORD;
  const auth=new PostgresAuthentication(url.toString()), persistence=new PostgresPersistence(url.toString());
  const service=await AuthenticationService.create(auth);
  const logs=[];
  const origin='http://127.0.0.1:3000';
  const server=createApp(persistence,fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),
    {service,origins:new Set([origin,'https://mimir.example.invalid']),allowLocalHttp:true,log:event=>logs.push(event)});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}/api/v1/session`;
  t.after(async()=>{server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await Promise.all([auth.close(),persistence.close(),admin.end()]);});
  const password=randomBytes(24).toString('hex');
  const email=`${randomUUID()}@example.invalid`;
  const owner=await createOwner({email,displayName:'Synthetic owner',companyName:'Synthetic company',password});
  const otherEmail=`${randomUUID()}@example.invalid`;
  const other=await createOwner({email:otherEmail,displayName:'Other owner',companyName:'Other company',password});
  const request=(method,headers={},body)=>fetch(base,{method,headers,...(body===undefined?{}:{body})});
  const login=(who=email,secret=password,headers={})=>request('POST',{'Content-Type':'application/json',Origin:origin,...headers},JSON.stringify({email:who,password:secret}));
  const token=response=>{
    const value=response.headers.get('set-cookie')?.match(/^mimir_session=([a-f0-9]{64});/)?.[1];
    assert.ok(value,'session cookie missing'); return value;
  };
  const cookie=value=>({Cookie:`mimir_session=${value}`});
  let current,csrf;

  await t.test('unauthenticated GET is 401 with exact sanitized error schema',async()=>{
    const response=await request('GET'); assert.equal(response.status,401);
    const body=await response.json(); assert.deepEqual(Object.keys(body).sort(),['code','message','requestId']);
    assert.equal(body.code,'AUTH_REQUIRED'); assert.equal(response.headers.get('cache-control'),'no-store');
  });
  await t.test('administrative provisioning hashes passwords and rolls back whole owner',async()=>{
    const row=(await admin.query('SELECT email,password_hash FROM mimir.users WHERE id=$1',[owner.userId])).rows[0];
    assert.ok(row.password_hash.startsWith('$argon2id$v=19$m=65536,t=3,p=1$'));
    assert.ok(!row.password_hash.includes(password));
    const ownerCounts='SELECT (SELECT count(*) FROM mimir.users WHERE email=$1)::int AS users,(SELECT count(*) FROM mimir.workspaces WHERE owner_id=$2)::int AS workspaces';
    const counts=(await admin.query(ownerCounts,[email,owner.userId])).rows[0];
    await assert.rejects(createOwner({email,displayName:'Duplicate',companyName:'Duplicate',password}),error=>error.code==='23505');
    assert.deepEqual((await admin.query(ownerCounts,[email,owner.userId])).rows[0],counts);
    const rejectedEmail=`${randomUUID()}@example.invalid`;
    await admin.query(`CREATE FUNCTION mimir.reject_i02_workspace() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.company_name='Reject I02 fixture' THEN RAISE EXCEPTION 'synthetic rejection'; END IF; RETURN NEW; END $$`);
    await admin.query('CREATE TRIGGER reject_i02_workspace BEFORE INSERT ON mimir.workspaces FOR EACH ROW EXECUTE FUNCTION mimir.reject_i02_workspace()');
    try {
      await assert.rejects(createOwner({email:rejectedEmail,displayName:'Rollback',companyName:'Reject I02 fixture',password}),error=>error.code==='P0001');
      assert.equal((await admin.query('SELECT 1 FROM mimir.users WHERE email=$1',[rejectedEmail])).rowCount,0);
    } finally {
      await admin.query('DROP TRIGGER reject_i02_workspace ON mimir.workspaces'); await admin.query('DROP FUNCTION mimir.reject_i02_workspace()');
    }
    const cli=spawnSync(process.execPath,['tools/admin/cli.mjs','create-owner'],{input:JSON.stringify({email:`${randomUUID()}@example.invalid`,displayName:'CLI',companyName:'CLI',password}),encoding:'utf8'});
    assert.equal(cli.status,0); assert.deepEqual(Object.keys(JSON.parse(cli.stdout)).sort(),['userId','workspaceId']);
    assert.ok(!cli.stdout.includes(password)&&!cli.stderr.includes(password));
    const unsafe=spawnSync(process.execPath,['tools/admin/cli.mjs','create-owner','forbidden-argument'],{encoding:'utf8'});
    assert.equal(unsafe.status,1);
  });
  await t.test('POST rejects Origin, media type, malformed/oversized/extra/UTF-8 bodies',async()=>{
    assert.equal((await login(email,password,{Origin:'http://evil.example.invalid'})).status,403);
    assert.equal((await request('POST',{'Content-Type':'application/json'},'{}')).status,403);
    assert.equal((await request('POST',{Origin:origin,'Content-Type':'text/plain'},'{}')).status,415);
    assert.equal((await request('POST',{Origin:origin,'Content-Type':'application/json'},'{')).status,400);
    assert.equal((await request('POST',{Origin:origin,'Content-Type':'application/json'},'x'.repeat(9000))).status,413);
    assert.equal((await request('POST',{Origin:origin,'Content-Type':'application/json'},JSON.stringify({email,password,workspaceId:other.workspaceId}))).status,422);
    assert.equal((await request('POST',{Origin:origin,'Content-Type':'application/json'},Buffer.from([0xff,0xfe]))).status,400);
  });
  await t.test('unknown, wrong and inactive credentials have same generic response',async()=>{
    const wrong=await login(email,randomBytes(24).toString('hex'));
    const missing=await login(`${randomUUID()}@example.invalid`);
    await admin.query('UPDATE mimir.users SET active=false WHERE id=$1',[other.userId]);
    const inactive=await login(otherEmail);
    for(const response of [wrong,missing,inactive]){assert.equal(response.status,401);assert.equal((await response.json()).code,'INVALID_CREDENTIALS');}
    await admin.query('UPDATE mimir.users SET active=true WHERE id=$1',[other.userId]);
  });
  await t.test('login returns exact owned context, secure cookie policy and only hashed token in DB',async()=>{
    const response=await login(); assert.equal(response.status,200); current=token(response);
    const body=await response.json(); csrf=body.csrfToken;
    assert.deepEqual(Object.keys(body).sort(),['csrfToken','displayName','revision','userId','workspace']);
    assert.deepEqual(body.workspace,{workspaceId:owner.workspaceId,companyName:'Synthetic company',currency:'BRL'});
    assert.equal(body.userId,owner.userId); assert.equal(body.revision,1); assert.ok(/^[a-f0-9]{64}$/.test(csrf));
    const header=response.headers.get('set-cookie');
    assert.ok(header.includes('HttpOnly')&&header.includes('SameSite=Lax')&&header.includes('Path=/')&&header.includes('Max-Age=28800')&&!header.includes('Secure'));
    const row=(await admin.query('SELECT token_hash,extract(epoch FROM(expires_at-created_at))::float8 AS lifetime FROM mimir.sessions WHERE token_hash=$1',[sessionHash(current)])).rows[0];
    assert.ok(row.token_hash===sessionHash(current)&&row.token_hash!==current); assert.ok(Math.abs(row.lifetime-28800)<1);
    const secure=await login(email,password,{Origin:'https://mimir.example.invalid'});
    assert.equal(secure.status,200); assert.ok(secure.headers.get('set-cookie').includes('; Secure'));
    const read=await request('GET',cookie(current)); assert.equal(read.status,200); assert.equal((await read.json()).userId,owner.userId);
    assert.equal((await request('GET',{Cookie:`mimir_session=${current}; mimir_session=${current}`})).status,401);
  });
  await t.test('duplicate browser cookie rejects POST without creating or revoking a session',async()=>{
    const before=(await admin.query('SELECT count(*)::int AS n FROM mimir.sessions')).rows[0].n;
    const response=await login(email,password,{Cookie:`mimir_session=${current}; mimir_session=${current}`});
    assert.equal(response.status,401);
    assert.equal(response.headers.get('set-cookie'),null);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM mimir.sessions')).rows[0].n,before);
    assert.equal((await request('GET',cookie(current))).status,200);
  });
  await t.test('rotation switches owner, revokes presented browser session, preserves revision',async()=>{
    const response=await login(otherEmail,password,cookie(current)); assert.equal(response.status,200);
    const next=token(response),body=await response.json();
    assert.equal(body.userId,other.userId);assert.equal(body.workspace.workspaceId,other.workspaceId);
    assert.equal((await request('GET',cookie(current))).status,401);
    current=next;csrf=body.csrfToken;
    const row=(await admin.query('SELECT revoked_at FROM mimir.sessions WHERE token_hash=$1',[sessionHash(current)])).rows[0]; assert.equal(row.revoked_at,null);
    await assert.rejects(auth.createSession(other.userId,sessionHash(current),sessionHash(current),randomBytes(32).toString('hex')),error=>error.code==='23505');
    assert.equal((await request('GET',cookie(current))).status,200,'failed rotation must roll back revocation');
    assert.equal((await admin.query('SELECT revision::int AS revision FROM mimir.workspaces WHERE id=$1',[other.workspaceId])).rows[0].revision,1);
  });
  await t.test('logout requires Origin and CSRF, revokes and clears cookie',async()=>{
    assert.equal((await request('DELETE',{...cookie(current),Origin:origin})).status,403);
    assert.equal((await request('DELETE',{...cookie(current),Origin:origin,'X-CSRF-Token':'a'.repeat(64)})).status,403);
    assert.equal((await request('DELETE',{...cookie(current),Origin:'http://evil.example.invalid','X-CSRF-Token':csrf})).status,403);
    assert.equal((await request('GET',cookie(current))).status,200);
    const response=await request('DELETE',{...cookie(current),Origin:origin,'X-CSRF-Token':csrf});
    assert.equal(response.status,204);assert.ok(response.headers.get('set-cookie').includes('Max-Age=0'));
    assert.equal((await request('GET',cookie(current))).status,401);
  });
  await t.test('expired, revoked and disabled-user sessions cannot authenticate',async()=>{
    const response=await login(); assert.equal(response.status,200); current=token(response);
    await admin.query("UPDATE mimir.sessions SET created_at=clock_timestamp()-interval '9 hours',expires_at=clock_timestamp()-interval '1 millisecond' WHERE token_hash=$1",[sessionHash(current)]);
    assert.equal((await request('GET',cookie(current))).status,401);
    current=token(await login());
    await admin.query('UPDATE mimir.users SET active=false WHERE id=$1',[owner.userId]);
    assert.equal((await request('GET',cookie(current))).status,401);
    await admin.query('UPDATE mimir.users SET active=true WHERE id=$1',[owner.userId]);
  });
  await t.test('sixth failure is 429 with Retry-After and spoofed forwarding cannot evade limit',async()=>{
    const name=`${randomUUID()}@example.invalid`;
    for(let i=0;i<5;i++)assert.equal((await login(name,password,{'X-Forwarded-For':`192.0.2.${i}`})).status,401);
    const response=await login(name,password,{'X-Forwarded-For':'198.51.100.8'});assert.equal(response.status,429);
    assert.ok(Number(response.headers.get('retry-after'))>0);
  });
  await t.test('runtime cannot rewrite session identity, expiry, hash or DELETE; logs omit secrets',async()=>{
    const runtime=new pg.Client({connectionString:url.toString()});await runtime.connect();
    try {
      for(const sql of ['UPDATE mimir.sessions SET expires_at=clock_timestamp()',"UPDATE mimir.sessions SET token_hash='forbidden'",'UPDATE mimir.sessions SET user_id=user_id','DELETE FROM mimir.sessions'])
        await assert.rejects(runtime.query(sql),error=>error.code==='42501');
    }finally{await runtime.end();}
    assert.ok(logs.length>20);
    for(const event of logs)assert.deepEqual(Object.keys(event).sort(),['durationMs','operation','requestId','status']);
    const encoded=JSON.stringify(logs);assert.ok(![password,current,csrf,email].some(value=>encoded.includes(value)));
  });
});
