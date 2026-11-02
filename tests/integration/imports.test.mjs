import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
const HEADER='external_id,occurred_on,direction,amount_cents,description,category,classification,is_pf_business_expense,explanation';
const csv=(...lines)=>Buffer.from([HEADER,...lines].join('\r\n')+'\r\n','utf8');
const line=(id,{date='2026-10-08',direction='SAIDA',amount=2500,description='Despesa importada',category='SERVICOS',classification='DESPESA',pf=false,explanation=''}={})=>
  [id,date,direction,amount,description,category,classification,pf,explanation].join(',');

test('I16 CSV import: HTTP and PostgreSQL',async t=>{
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  const url=new URL(process.env.MIGRATION_DATABASE_URL);url.username='mimir_runtime';url.password=process.env.APP_ROLE_PASSWORD;const runtimeUrl=url.toString();
  const auth=new PostgresAuthentication(runtimeUrl),persistence=new PostgresPersistence(runtimeUrl),accounts=new PostgresAccounts(runtimeUrl);
  const transactions=new PostgresTransactions(runtimeUrl),documents=new PostgresDocuments(runtimeUrl),preview=new PostgresPreview(runtimeUrl);
  const deliveries=new PostgresDeliveries(runtimeUrl),reimbursements=new PostgresReimbursements(runtimeUrl),pendingItems=new PostgresPendingItems(runtimeUrl);
  const importsModule=await import('../../apps/api/dist/adapters/postgres-imports.js').catch(()=>null),imports=importsModule?new importsModule.PostgresImports(runtimeUrl):undefined;
  const scope=new Set(),executorPort=new PostgresExecutor(runtimeUrl,scope),workRoot=await mkdtemp(join(tmpdir(),'mimir-i16-work-'));
  const service=await AuthenticationService.create(auth),origin='http://127.0.0.1:3000';
  const server=createApp(persistence,fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),{service,origins:new Set([origin]),allowLocalHttp:true,log:()=>{}},
    accounts,transactions,documents,preview,deliveries,reimbursements,pendingItems,imports);
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));
    await Promise.all([admin.end(),auth.close(),persistence.close(),accounts.close(),transactions.close(),documents.close(),preview.close(),deliveries.close(),
      reimbursements.close(),pendingItems.close(),executorPort.close(),imports?.close()]);
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
  const form=(fields,file)=>{const body=new FormData();body.append('file',new Blob([file],{type:'text/csv'}),'extrato.csv');for(const [k,v] of Object.entries(fields))body.append(k,String(v));return body;};
  const previewImport=(who,accountId,file,{sourceCode='banco-x',periodMonth='2026-10'}={})=>fetch(base+'/api/v1/imports/preview',{method:'POST',headers:headers(who),
    body:form({accountId,sourceCode,periodMonth},file)});
  async function confirmImport(who,accountId,file,{sourceCode='banco-x',periodMonth='2026-10',hash=sha(file),rev}={}){
    return fetch(base+'/api/v1/imports/confirm',{method:'POST',headers:headers(who),body:form({accountId,sourceCode,periodMonth,expectedFileHash:hash,expectedRevision:rev??await revision(who)},file)});
  }
  const count=async(who,table)=>(await admin.query(`SELECT count(*)::int n FROM mimir.${table} WHERE workspace_id=$1`,[who.workspaceId])).rows[0].n;
  const snapshot=async who=>({rev:await revision(who),tx:await count(who,'transactions'),origins:await count(who,'import_origins'),batches:await count(who,'import_batches'),pending:await count(who,'pending_items')});
  const unchanged=async(who,work)=>{const before=await snapshot(who);await work();assert.deepEqual(await snapshot(who),before);};
  const code=async(r,status,expected)=>{assert.equal(r.status,status);if(expected)assert.equal((await r.json()).code,expected);};

  await t.test('migration 010: tables, uniqueness, runtime grants and provenance trigger; readiness requires it',async()=>{
    assert.equal(await persistence.ready(),true);
    assert.equal((await admin.query("SELECT count(*)::int n FROM mimir.schema_migrations WHERE version='010_csv_import.sql'")).rows[0].n,1);
    const privileges=(await admin.query(`SELECT table_name,string_agg(privilege_type,',' ORDER BY privilege_type) p FROM information_schema.role_table_grants
      WHERE grantee='mimir_runtime' AND table_name IN ('import_origins','import_batches') GROUP BY table_name ORDER BY table_name`)).rows;
    assert.deepEqual(privileges,[{table_name:'import_batches',p:'INSERT,SELECT'},{table_name:'import_origins',p:'INSERT,SELECT'}]);
    const a=await owner('Synthetic I16 M'),acc=await account(a,'PJ');
    assert.equal((await confirmImport(a,acc,csv(line('M1')))).status,201);
    const runtime=new pg.Client({connectionString:runtimeUrl});await runtime.connect();
    try{
      await assert.rejects(runtime.query("UPDATE mimir.transactions SET external_id='x' WHERE workspace_id=$1",[a.workspaceId]),e=>e.code==='23514');
      await assert.rejects(runtime.query("UPDATE mimir.transactions SET source_code='y' WHERE workspace_id=$1",[a.workspaceId]),e=>e.code==='23514');
      await assert.rejects(runtime.query("UPDATE mimir.transactions SET source_type='MANUAL' WHERE workspace_id=$1",[a.workspaceId]),e=>e.code==='23514');
      await runtime.query("UPDATE mimir.transactions SET description='editada' WHERE workspace_id=$1",[a.workspaceId]);
      const otherAccount=await account(a,'PJ');
      await assert.rejects(runtime.query('UPDATE mimir.transactions SET account_id=$2 WHERE workspace_id=$1',[a.workspaceId,otherAccount]),e=>e.code==='23514');
      await assert.rejects(runtime.query('UPDATE mimir.import_origins SET external_id=external_id WHERE workspace_id=$1',[a.workspaceId]),e=>e.code==='42501');
      await assert.rejects(runtime.query('DELETE FROM mimir.import_origins WHERE workspace_id=$1',[a.workspaceId]),e=>e.code==='42501');
      await assert.rejects(runtime.query('DELETE FROM mimir.import_batches WHERE workspace_id=$1',[a.workspaceId]),e=>e.code==='42501');
      const o=(await admin.query('SELECT * FROM mimir.import_origins WHERE workspace_id=$1',[a.workspaceId])).rows[0];
      await assert.rejects(admin.query(`INSERT INTO mimir.import_origins(id,workspace_id,account_id,source_code,external_id,transaction_id,original_fingerprint,normalized_original_row)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),o.workspace_id,o.account_id,o.source_code,o.external_id,o.transaction_id,o.original_fingerprint,o.normalized_original_row]),e=>e.code==='23505');
    }finally{await runtime.end();}
  });

  const a=await owner('Synthetic I16 A'),b=await owner('Synthetic I16 B');
  const pj=await account(a,'PJ'),pf=await account(a,'PF'),pjB=await account(b,'PJ');

  await t.test('US1 preview classifies lines, reports totals, hash and unknown source without writing',async()=>{
    const file=csv(line('P1'),line('P2',{amount:'12.50'}),line('P3',{date:'2026-11-01'}),line('P1'),line('P4',{description:'x'}),line('P4',{description:'y'}),
      line('P5',{classification:'RECEITA'}));
    let body;
    await unchanged(a,async()=>{const r=await previewImport(a,pj,file);assert.equal(r.status,200);body=await r.json();});
    assert.deepEqual(Object.keys(body).sort(),['accountId','fileHash','periodMonth','revision','rows','sourceCode','sourceCodeKnown','totals']);
    assert.equal(body.fileHash,sha(file));assert.equal(body.revision,await revision(a));assert.equal(body.sourceCodeKnown,false);
    assert.deepEqual(body.rows.map(r=>[r.line,r.externalId,r.status,r.code]),[[2,'P1','NOVA',null],[3,'P2','INVALIDA','INVALID_FIELD'],[4,'P3','INVALIDA','OUT_OF_PERIOD'],
      [5,'P1','REPETIDA',null],[6,'P4','CONFLITO','DUPLICATE_KEY_DIFFERENT_CONTENT'],[7,'P4','CONFLITO','DUPLICATE_KEY_DIFFERENT_CONTENT'],[8,'P5','INVALIDA','INVALID_RULE']]);
    assert.deepEqual(body.totals,{rows:7,new:1,ignored:0,repeated:1,conflicting:2,invalid:3});
    assert.ok(body.rows[1].message.includes('amount_cents'));
    await code(await previewImport(a,pj,Buffer.from('a,b\n1,2\n')),422,'INVALID_CSV');
    await code(await previewImport(a,pj,Buffer.from([0xff,0xfe])),422,'INVALID_CSV');
    await code(await previewImport(a,pjB,csv(line('X'))),404,'NOT_FOUND');
    await code(await previewImport(a,randomUUID(),csv(line('X'))),404,'NOT_FOUND');
    await code(await previewImport(a,pj,csv(line('X')),{periodMonth:'2026-13'}),422);
    await code(await previewImport(a,pj,csv(line('X')),{sourceCode:'  '}),422,'INVALID_INPUT');
    await code(await previewImport(a,pj,csv(line('X')),{sourceCode:' MANUAL '}),422,'INVALID_INPUT');
    await code(await previewImport(a,pj,Buffer.concat([csv(line('X')),Buffer.alloc(1048577,0x20)])),413);
    await code(await fetch(base+'/api/v1/imports/preview',{method:'POST',headers:{Origin:origin},body:form({accountId:pj,sourceCode:'s',periodMonth:'2026-10'},csv(line('X')))}),401);
    await code(await fetch(base+'/api/v1/imports/preview',{method:'GET',headers:headers(a)}),405,'METHOD_NOT_ALLOWED');
    await admin.query('UPDATE mimir.accounts SET active=false WHERE id=$1',[pf]);
    await code(await previewImport(a,pf,csv(line('X'))),409,'ACCOUNT_INACTIVE');
    await admin.query('UPDATE mimir.accounts SET active=true WHERE id=$1',[pf]);
  });

  await t.test('US2 confirm writes the whole batch atomically with provenance, pending items and one revision',async()=>{
    const file=csv(line('C1'),line('C2',{direction:'ENTRADA',classification:'RECEITA',amount:999}),line('C3',{classification:'TRANSFERENCIA'}),line('C1'));
    const before=await snapshot(a),r=await confirmImport(a,pj,file,{sourceCode:'banco-c'});assert.equal(r.status,201);const body=await r.json();
    assert.deepEqual(Object.keys(body).sort(),['batchId','fileHash','revision','totals','transactionIds']);
    assert.equal(body.revision,before.rev+1);assert.equal(await revision(a),before.rev+1);assert.equal(body.transactionIds.length,3);
    assert.deepEqual(body.totals,{rows:4,new:3,ignored:0,repeated:1,conflicting:0,invalid:0});
    const txs=(await admin.query(`SELECT external_id,source_type,source_code,amount_cents::int a,classification,occurred_on::text d FROM mimir.transactions WHERE id=ANY($1) ORDER BY external_id`,[body.transactionIds])).rows;
    assert.deepEqual(txs,[{external_id:'C1',source_type:'CSV',source_code:'banco-c',a:2500,classification:'DESPESA',d:'2026-10-08'},
      {external_id:'C2',source_type:'CSV',source_code:'banco-c',a:999,classification:'RECEITA',d:'2026-10-08'},
      {external_id:'C3',source_type:'CSV',source_code:'banco-c',a:2500,classification:'TRANSFERENCIA',d:'2026-10-08'}]);
    const origins=(await admin.query('SELECT external_id,original_fingerprint,normalized_original_row FROM mimir.import_origins WHERE transaction_id=ANY($1) ORDER BY external_id',[body.transactionIds])).rows;
    assert.equal(origins.length,3);assert.equal(origins[0].normalized_original_row.externalId,'C1');assert.match(origins[0].original_fingerprint,/^[0-9a-f]{64}$/);
    const batch=(await admin.query('SELECT file_hash,row_count,inserted_count,ignored_count,repeated_count,period_month FROM mimir.import_batches WHERE id=$1',[body.batchId])).rows[0];
    assert.deepEqual(batch,{file_hash:sha(file),row_count:4,inserted_count:3,ignored_count:0,repeated_count:1,period_month:'2026-10'});
    const pend=(await admin.query('SELECT t.external_id,p.type FROM mimir.pending_items p JOIN mimir.transactions t ON t.id=p.transaction_id WHERE t.id=ANY($1) ORDER BY 1,2',[body.transactionIds])).rows;
    assert.deepEqual(pend.map(p=>[p.external_id,p.type]),[['C1','DOCUMENTO_AUSENTE'],['C2','DOCUMENTO_AUSENTE']]);
    const list=await (await fetch(base+'/api/v1/transactions?periodMonth=2026-10',{headers:headers(a)})).json();
    assert.ok((list.items??list.transactions).some(t=>t.externalId==='C1'&&t.sourceType==='CSV'));
  });

  await t.test('US2 invalid rows, conflicts, hash mismatch and stale revision write nothing',async()=>{
    await unchanged(a,async()=>{
      await code(await confirmImport(a,pj,csv(line('E1'),line('E2',{amount:'x'}))),422,'IMPORT_INVALID_ROWS');
      await code(await confirmImport(a,pj,csv(line('E3'),line('E3',{amount:7}))),409,'IMPORT_CONFLICT');
      await code(await confirmImport(a,pj,csv(line('E4')),{hash:'0'.repeat(64)}),422,'FILE_HASH_MISMATCH');
      await code(await confirmImport(a,pj,csv(line('E5')),{rev:1}),409,'REVISION_CONFLICT');
      await code(await confirmImport(a,pj,Buffer.from('lixo')),422,'INVALID_CSV');
      await code(await confirmImport(a,pjB,csv(line('E6'))),404,'NOT_FOUND');
      const file=csv(line('E7'));
      await code(await fetch(base+'/api/v1/imports/confirm',{method:'POST',headers:{Origin:origin,Cookie:`mimir_session=${a.token}`},
        body:form({accountId:pj,sourceCode:'banco-x',periodMonth:'2026-10',expectedFileHash:sha(file),expectedRevision:await revision(a)},file)}),403);
      await code(await fetch(base+'/api/v1/imports/confirm',{method:'POST',headers:{...headers(a),Origin:'http://evil.invalid'},
        body:form({accountId:pj,sourceCode:'banco-x',periodMonth:'2026-10',expectedFileHash:sha(file),expectedRevision:await revision(a)},file)}),403);
      const extra=form({accountId:pj,sourceCode:'banco-x',periodMonth:'2026-10',expectedFileHash:sha(file),expectedRevision:await revision(a),x:'1'},file);
      await code(await fetch(base+'/api/v1/imports/confirm',{method:'POST',headers:headers(a),body:extra}),422,'INVALID_INPUT');
    });
  });

  await t.test('US2 concurrency: same file twice with the same revision commits once',async()=>{
    const file=csv(line('K1'),line('K2')),rev=await revision(a);
    const results=await Promise.all([confirmImport(a,pj,file,{rev,sourceCode:'banco-k'}),confirmImport(a,pj,file,{rev,sourceCode:'banco-k'})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(await revision(a),rev+1);
    assert.equal((await admin.query("SELECT count(*)::int n FROM mimir.import_origins WHERE workspace_id=$1 AND source_code='banco-k'",[a.workspaceId])).rows[0].n,2);
  });

  await t.test('US3 reimport: same file is a no-op even with stale revision; local edits preserved; only new lines enter; changed and deleted origins conflict',async()=>{
    const file=csv(line('R1',{description:'Original'}),line('R2'));
    const first=await confirmImport(a,pj,file,{sourceCode:'banco-r'});assert.equal(first.status,201);const [r1,r2]=(await first.json()).transactionIds;
    const p=await (await previewImport(a,pj,file,{sourceCode:'banco-r'})).json();assert.equal(p.sourceCodeKnown,true);
    assert.deepEqual(p.rows.map(r=>r.status),['IGNORADA','IGNORADA']);
    await unchanged(a,async()=>{const r=await confirmImport(a,pj,file,{sourceCode:'banco-r',rev:1});assert.equal(r.status,200);
      const body=await r.json();assert.equal(body.batchId,null);assert.deepEqual(body.transactionIds,[]);assert.equal(body.totals.ignored,2);});
    const patched=await fetch(base+`/api/v1/transactions/${r1}`,{method:'PATCH',headers:json(a),body:JSON.stringify({description:'Editada localmente',classification:'A_ESCLARECER',expectedRevision:await revision(a)})});
    assert.equal(patched.status,200);
    await unchanged(a,async()=>assert.equal((await confirmImport(a,pj,file,{sourceCode:'banco-r'})).status,200));
    assert.equal((await admin.query('SELECT description FROM mimir.transactions WHERE id=$1',[r1])).rows[0].description,'Editada localmente');
    const grown=csv(line('R1',{description:'Original'}),line('R2'),line('R3'));
    const g=await confirmImport(a,pj,grown,{sourceCode:'banco-r'});assert.equal(g.status,201);const gb=await g.json();
    assert.equal(gb.transactionIds.length,1);assert.deepEqual(gb.totals,{rows:3,new:1,ignored:2,repeated:0,conflicting:0,invalid:0});
    await unchanged(a,async()=>{
      const changed=await (await previewImport(a,pj,csv(line('R1',{description:'Outra'})),{sourceCode:'banco-r'})).json();
      assert.deepEqual([changed.rows[0].status,changed.rows[0].code],['CONFLITO','ORIGIN_CHANGED']);
      await code(await confirmImport(a,pj,csv(line('R1',{description:'Outra'})),{sourceCode:'banco-r'}),409,'IMPORT_CONFLICT');
    });
    const del=await fetch(base+`/api/v1/transactions/${r2}`,{method:'DELETE',headers:json(a),body:JSON.stringify({expectedRevision:await revision(a)})});assert.equal(del.status,200);
    await unchanged(a,async()=>{
      const gone=await (await previewImport(a,pj,csv(line('R2')),{sourceCode:'banco-r'})).json();
      assert.deepEqual([gone.rows[0].status,gone.rows[0].code],['CONFLITO','ORIGIN_DELETED']);
      await code(await confirmImport(a,pj,csv(line('R2')),{sourceCode:'banco-r'}),409,'IMPORT_CONFLICT');
    });
    assert.equal((await admin.query('SELECT status FROM mimir.transactions WHERE id=$1',[r2])).rows[0].status,'EXCLUIDA','não restaura');
    const otherSource=await confirmImport(a,pj,csv(line('R1',{description:'Original'})),{sourceCode:'banco-outro'});assert.equal(otherSource.status,201);
    const otherAccount=await account(a,'PJ'),oa=await confirmImport(a,otherAccount,csv(line('R1',{description:'Original'})),{sourceCode:'banco-r'});assert.equal(oa.status,201);
    const pfFile=csv(line('PF1',{pf:true}));
    await code(await confirmImport(a,pj,pfFile,{sourceCode:'banco-pf'}),422,'IMPORT_INVALID_ROWS');
    assert.equal((await confirmImport(a,pf,pfFile,{sourceCode:'banco-pf'})).status,201);
  });

  await t.test('limit batch: 1,000 new lines confirm in one commit well within the HTTP timeout',async()=>{
    const v=await owner('Synthetic I16 V'),acc=await account(v,'PJ');
    const file=csv(...Array.from({length:1000},(_,i)=>line(`V${String(i).padStart(4,'0')}`,{amount:i+1})));
    const p=await previewImport(v,acc,file);assert.equal(p.status,200);assert.equal((await p.json()).totals.new,1000);
    const started=performance.now(),r=await confirmImport(v,acc,file),elapsed=performance.now()-started;
    assert.equal(r.status,201);assert.equal((await r.json()).transactionIds.length,1000);
    assert.ok(elapsed<5000,`confirmação de 1.000 linhas levou ${Math.round(elapsed)} ms`);
    assert.equal(await count(v,'transactions'),1000);assert.equal(await count(v,'import_origins'),1000);assert.equal(await count(v,'pending_items'),1000);
    const again=performance.now();assert.equal((await confirmImport(v,acc,file)).status,200);assert.ok(performance.now()-again<5000);
  });

  await t.test('imported transaction keeps provenance on edit and its account cannot change',async()=>{
    const r=await confirmImport(a,pj,csv(line('L1')),{sourceCode:'banco-l'});const [id]=(await r.json()).transactionIds;
    const other=await account(a,'PJ');
    await code(await fetch(base+`/api/v1/transactions/${id}`,{method:'PATCH',headers:json(a),body:JSON.stringify({accountId:other,expectedRevision:await revision(a)})}),409,'IMPORTED_TRANSACTION_ACCOUNT_LOCKED');
    assert.equal((await fetch(base+`/api/v1/transactions/${id}`,{method:'PATCH',headers:json(a),body:JSON.stringify({amountCents:1,expectedRevision:await revision(a)})})).status,200);
    const row=(await admin.query('SELECT source_type,source_code,external_id FROM mimir.transactions WHERE id=$1',[id])).rows[0];
    assert.deepEqual(row,{source_type:'CSV',source_code:'banco-l',external_id:'L1'});
    const origin=(await admin.query('SELECT normalized_original_row FROM mimir.import_origins WHERE transaction_id=$1',[id])).rows[0];
    assert.equal(origin.normalized_original_row.amountCents,2500,'procedência guarda o valor original');
  });

  await t.test('captured delivery stays byte-identical after an import; a new capture includes imported rows',async()=>{
    const d=await owner('Synthetic I16 D'),acc=await account(d,'PJ');
    const worker=new DeliveryExecutor(executorPort,{workRoot,pollMs:50,renewMs:50});
    assert.equal((await confirmImport(d,acc,csv(line('D1')))).status,201);
    async function capture(reason=''){
      const r=await fetch(base+'/api/v1/deliveries',{method:'POST',headers:{...json(d),'Idempotency-Key':randomUUID()},body:JSON.stringify({periodMonth:'2026-10',expectedRevision:await revision(d),rectificationReason:reason})});
      assert.equal(r.status,202);const op=await r.json();
      for(let i=0;i<80;i++){const s=await (await fetch(base+`/api/v1/operations/${op.id}`,{headers:headers(d)})).json();if(s.status==='PRONTA')return op;assert.notEqual(s.status,'FALHA');await worker.tick();await sleep(60);}
      assert.fail('delivery not ready');
    }
    const download=async(op,kind)=>Buffer.from(await (await fetch(base+`/api/v1/deliveries/${op.snapshotId}/${kind}`,{headers:headers(d)})).arrayBuffer());
    const v1=await capture(),zip=await download(v1,'package');
    assert.equal((await confirmImport(d,acc,csv(line('D1'),line('D2')))).status,201);
    assert.ok((await download(v1,'package')).equals(zip));
    const v2=await capture('Novo lote importado'),manifest=JSON.parse((await download(v2,'manifest')).toString('utf8'));
    assert.deepEqual(manifest.transactions.map(x=>[x.sourceType,x.sourceCode,x.externalId]).sort(),[['CSV','banco-x','D1'],['CSV','banco-x','D2']]);
  });
});
