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

test('I12 transaction correction and logical deletion: HTTP and PostgreSQL',async t=>{
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  const url=new URL(process.env.MIGRATION_DATABASE_URL);url.username='mimir_runtime';url.password=process.env.APP_ROLE_PASSWORD;const runtimeUrl=url.toString();
  const auth=new PostgresAuthentication(runtimeUrl),persistence=new PostgresPersistence(runtimeUrl),accounts=new PostgresAccounts(runtimeUrl);
  const transactions=new PostgresTransactions(runtimeUrl),documents=new PostgresDocuments(runtimeUrl),preview=new PostgresPreview(runtimeUrl);
  const deliveries=new PostgresDeliveries(runtimeUrl),reimbursements=new PostgresReimbursements(runtimeUrl);
  const scope=new Set(),executorPort=new PostgresExecutor(runtimeUrl,scope),workRoot=await mkdtemp(join(tmpdir(),'mimir-i12-work-'));
  const service=await AuthenticationService.create(auth),origin='http://127.0.0.1:3000';
  const server=createApp(persistence,fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),{service,origins:new Set([origin]),allowLocalHttp:true,log:()=>{}},
    accounts,transactions,documents,preview,deliveries,reimbursements);
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));
    await Promise.all([admin.end(),auth.close(),persistence.close(),accounts.close(),transactions.close(),documents.close(),preview.close(),deliveries.close(),reimbursements.close(),executorPort.close()]);
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
    const body={accountId,occurredOn:fields.date,direction:fields.direction??'SAIDA',amountCents:fields.amount??10000,description:fields.description??'Synthetic I12',
      category:fields.category??'GERAL',classification:fields.classification??'DESPESA',isPfBusinessExpense:fields.business??false,explanation:fields.explanation??'',expectedRevision:await revision(who)};
    const r=await fetch(base+'/api/v1/transactions',{method:'POST',headers:json(who),body:JSON.stringify(body)});assert.equal(r.status,201);
    return (await r.json()).transaction.transactionId;
  }
  async function upload(who,id,label='doc'){
    const body=new FormData();body.append('file',new Blob([Buffer.from(`%PDF-1.7\nSynthetic I12 ${label}\n%%EOF\n`)],{type:'application/pdf'}),`${label}.pdf`);
    body.append('expectedRevision',String(await revision(who)));
    return fetch(base+`/api/v1/transactions/${id}/documents`,{method:'POST',headers:headers(who),body});
  }
  const patch=async(who,id,changes,rev)=>fetch(base+`/api/v1/transactions/${id}`,{method:'PATCH',headers:json(who),body:JSON.stringify({...changes,expectedRevision:rev??await revision(who)})});
  const del=async(who,id,rev)=>fetch(base+`/api/v1/transactions/${id}`,{method:'DELETE',headers:json(who),body:JSON.stringify({expectedRevision:rev??await revision(who)})});
  const readPreview=async(who,month)=>{const r=await fetch(base+`/api/v1/periods/${month}/preview`,{headers:headers(who)});assert.equal(r.status,200);return r.json();};
  const pendings=async id=>Object.fromEntries((await admin.query('SELECT type,status,justification FROM mimir.pending_items WHERE transaction_id=$1',[id])).rows.map(r=>[r.type,[r.status,r.justification]]));
  const code=async(r,status,expected)=>{assert.equal(r.status,status);if(expected)assert.equal((await r.json()).code,expected);};

  const a=await owner('Synthetic I12 A'),b=await owner('Synthetic I12 B');
  const pfA=await account(a,'PF'),pjA=await account(a,'PJ'),pj2A=await account(a,'PJ'),pjB=await account(b,'PJ');

  await t.test('PATCH corrects amount and text once, moves across months and returns the exact record',async()=>{
    const id=await tx(a,pjA,{date:'2026-10-05',amount:10000,description:'Licença sintética',category:'SOFTWARE'});
    const rev=await revision(a);
    const r=await patch(a,id,{amountCents:12000,description:'  Licença anual  '},rev);assert.equal(r.status,200);const body=await r.json();
    assert.equal(body.revision,rev+1);assert.equal(await revision(a),rev+1);
    assert.deepEqual(Object.keys(body.transaction).sort(),['accountId','accountName','accountType','amountCents','categoryOriginal','classification','descriptionOriginal','direction','documentIds',
      'explanationOriginal','externalId','isPfBusinessExpense','occurredOn','periodMonth','reimbursementLinkId','sourceCode','sourceType','status','transactionId'].sort());
    assert.equal(body.transaction.amountCents,12000);assert.equal(body.transaction.descriptionOriginal,'Licença anual');assert.equal(body.transaction.status,'ATIVA');
    const october=await readPreview(a,'2026-10');assert.equal(october.transactions.find(x=>x.transactionId===id).amountCents,12000);
    const moved=await patch(a,id,{occurredOn:'2027-03-02'});assert.equal(moved.status,200);assert.equal((await moved.json()).transaction.periodMonth,'2027-03');
    assert.ok(!(await readPreview(a,'2026-10')).transactions.some(x=>x.transactionId===id));
    assert.ok((await readPreview(a,'2027-03')).transactions.some(x=>x.transactionId===id));
    assert.equal((await admin.query("SELECT count(*)::int n FROM mimir.periods WHERE workspace_id=$1 AND period_month='2027-03'",[a.workspaceId])).rows[0].n,1);
    const changeAccount=await patch(a,id,{accountId:pj2A});assert.equal(changeAccount.status,200);assert.equal((await changeAccount.json()).transaction.accountId,pj2A);
  });

  await t.test('PATCH without effective change keeps revision and pending items',async()=>{
    const id=await tx(a,pjA,{date:'2026-10-06',amount:500,description:'Igual'});
    const rev=await revision(a),before=await pendings(id);
    const r=await patch(a,id,{amountCents:500,description:'Igual '},rev);assert.equal(r.status,200);assert.equal((await r.json()).revision,rev);
    assert.equal(await revision(a),rev);assert.deepEqual(await pendings(id),before);
  });

  await t.test('PATCH rejects stale revision, invalid rules, foreign or inactive account and foreign transaction without side effects',async()=>{
    const id=await tx(a,pfA,{date:'2026-10-07'}),foreign=await tx(b,pjB,{date:'2026-10-07'});const rev=await revision(a);
    await code(await patch(a,id,{amountCents:1},rev-1),409,'REVISION_CONFLICT');
    await code(await patch(a,id,{classification:'RECEITA'},rev),422,'INVALID_INPUT');
    await code(await patch(a,id,{direction:'ENTRADA'},rev),422,'INVALID_INPUT');
    await code(await patch(a,id,{isPfBusinessExpense:true,accountId:pjA},rev),422);
    await code(await patch(a,id,{accountId:pjB},rev),404,'NOT_FOUND');
    await code(await patch(b,id,{amountCents:1}),404,'NOT_FOUND');
    await code(await patch(a,foreign,{amountCents:1},rev),404,'NOT_FOUND');
    await code(await patch(a,id,{periodMonth:'2026-11'},rev),422,'INVALID_INPUT');
    await code(await patch(a,'not-a-uuid',{amountCents:1},rev),422);
    await code(await fetch(base+`/api/v1/transactions/${id}`,{method:'PATCH',headers:{...json(a),'X-CSRF-Token':'0'.repeat(64)},body:JSON.stringify({amountCents:1,expectedRevision:rev})}),403);
    await code(await fetch(base+`/api/v1/transactions/${id}`,{method:'PATCH',headers:{...json(a),Origin:'http://evil.invalid'},body:JSON.stringify({amountCents:1,expectedRevision:rev})}),403);
    const imported=randomUUID();
    await admin.query(`INSERT INTO mimir.transactions(id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,description,category,classification,explanation,source_type,source_code,external_id)
      VALUES($1,$2,$3,'2026-10-07','2026-10','SAIDA',100,'Importada','GERAL','TRANSFERENCIA','','CSV','BANCO','ext-1')`,[imported,a.workspaceId,pfA]);
    await code(await patch(a,imported,{accountId:pjA},rev),409,'IMPORTED_TRANSACTION_ACCOUNT_LOCKED');
    const inactive=randomUUID();
    await admin.query('INSERT INTO mimir.accounts(id,workspace_id,name,name_key,account_type,active) VALUES($1,$2,$3,$3,$4,false)',[inactive,a.workspaceId,'inativa '+inactive,'PF']);
    await code(await patch(a,id,{accountId:inactive},rev),409,'ACCOUNT_INACTIVE');
    assert.equal(await revision(a),rev);
    assert.equal((await admin.query('SELECT amount_cents::int n FROM mimir.transactions WHERE id=$1',[id])).rows[0].n,10000);
  });

  await t.test('concurrent PATCH with the same revision: exactly one applies',async()=>{
    const id=await tx(a,pjA,{date:'2026-10-08',amount:700});const rev=await revision(a);
    const results=await Promise.all([patch(a,id,{amountCents:701},rev),patch(a,id,{amountCents:702},rev)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(await revision(a),rev+1);
  });

  await t.test('pending reconciliation matches the hand-written oracle',async()=>{
    const id=await tx(a,pfA,{date:'2026-10-09',classification:'A_ESCLARECER'});
    assert.deepEqual(await pendings(id),{CLASSIFICACAO_A_ESCLARECER:['PENDENTE','']});
    assert.equal((await patch(a,id,{classification:'DESPESA'})).status,200);
    assert.deepEqual(await pendings(id),{CLASSIFICACAO_A_ESCLARECER:['RESOLVIDA',''],DOCUMENTO_AUSENTE:['PENDENTE','']});
    assert.equal((await patch(a,id,{isPfBusinessExpense:true})).status,200);
    assert.deepEqual((await pendings(id)).REEMBOLSO_PF_PENDENTE,['PENDENTE','']);
    await admin.query("UPDATE mimir.pending_items SET status='JUSTIFICADA',justification='Comprovante extraviado' WHERE transaction_id=$1 AND type='DOCUMENTO_AUSENTE'",[id]);
    assert.equal((await patch(a,id,{explanation:'Nota fiscal pedida ao fornecedor'})).status,200);
    assert.deepEqual((await pendings(id)).DOCUMENTO_AUSENTE,['JUSTIFICADA','Comprovante extraviado'],'text-only change keeps justification');
    assert.equal((await patch(a,id,{amountCents:10001})).status,200);
    assert.deepEqual((await pendings(id)).DOCUMENTO_AUSENTE,['PENDENTE',''],'material change reopens justified');
    assert.equal((await patch(a,id,{isPfBusinessExpense:false,classification:'TRANSFERENCIA'})).status,200);
    assert.deepEqual(await pendings(id),{CLASSIFICACAO_A_ESCLARECER:['RESOLVIDA',''],DOCUMENTO_AUSENTE:['RESOLVIDA',''],REEMBOLSO_PF_PENDENTE:['RESOLVIDA','']});
    assert.equal((await patch(a,id,{classification:'DESPESA'})).status,200);
    assert.deepEqual((await pendings(id)).DOCUMENTO_AUSENTE,['PENDENTE',''],'resolved cause reappears');
    assert.equal((await upload(a,id)).status,201);
    assert.equal((await patch(a,id,{amountCents:10002})).status,200);
    assert.deepEqual((await pendings(id)).DOCUMENTO_AUSENTE,['RESOLVIDA',''],'document keeps documentary cause resolved');
  });

  await t.test('linked transaction: material change and deletion conflict, text allowed, allowed again after undo',async()=>{
    const expense=await tx(a,pfA,{date:'2026-10-10',business:true}),outflow=await tx(a,pjA,{date:'2026-10-20',classification:'TRANSFERENCIA'});
    const linked=await fetch(base+'/api/v1/reimbursements',{method:'POST',headers:json(a),body:JSON.stringify({pfExpenseTransactionId:expense,pjReimbursementTransactionId:outflow,pfInflowTransactionId:null,notes:'',expectedRevision:await revision(a)})});
    assert.equal(linked.status,201);const linkId=(await linked.json()).reimbursement.reimbursementLinkId;
    const rev=await revision(a);
    for(const changes of [{amountCents:1},{occurredOn:'2026-10-11'},{accountId:(await account(a,'PF'))},{classification:'A_ESCLARECER',isPfBusinessExpense:false},{isPfBusinessExpense:false}])
      await code(await patch(a,expense,changes),409,'LINKED_TRANSACTION_CONFLICT');
    await code(await patch(a,outflow,{direction:'ENTRADA'}),409,'LINKED_TRANSACTION_CONFLICT');
    await code(await del(a,outflow),409,'LINKED_TRANSACTION_CONFLICT');
    const afterConflicts=await revision(a);assert.equal(afterConflicts,rev+1,'only the helper account changed revision');
    const text=await patch(a,expense,{description:'Hospedagem corrigida',category:'INFRA',explanation:'Plano anual'});assert.equal(text.status,200);
    const record=(await text.json()).transaction;assert.equal(record.reimbursementLinkId,linkId);assert.equal(record.descriptionOriginal,'Hospedagem corrigida');
    assert.equal((await (await fetch(base+`/api/v1/transactions/${outflow}`,{headers:headers(a)})).json()).reimbursementLinkId,linkId);
    assert.equal((await fetch(base+`/api/v1/reimbursements/${linkId}`,{method:'DELETE',headers:json(a),body:JSON.stringify({expectedRevision:await revision(a)})})).status,200);
    assert.equal((await patch(a,expense,{amountCents:1})).status,200);
    assert.equal((await del(a,outflow)).status,200);
  });

  await t.test('DELETE is logical: gone from preview, documents kept, repeated deletion and later mutations conflict',async()=>{
    const id=await tx(a,pjA,{date:'2026-10-21',amount:3333});assert.equal((await upload(a,id,'excluir')).status,201);
    const rev=await revision(a);
    await code(await del(a,id,rev-1),409,'REVISION_CONFLICT');
    await code(await del(b,id),404,'NOT_FOUND');
    const r=await del(a,id,rev);assert.equal(r.status,200);const body=await r.json();
    assert.equal(body.revision,rev+1);assert.equal(body.transaction.status,'EXCLUIDA');assert.equal(body.transaction.documentIds.length,1);
    assert.ok(!(await readPreview(a,'2026-10')).transactions.some(x=>x.transactionId===id));
    assert.equal((await admin.query('SELECT count(*)::int n FROM mimir.transaction_documents WHERE transaction_id=$1',[id])).rows[0].n,1);
    await code(await del(a,id),409,'TRANSACTION_ALREADY_DELETED');
    await code(await patch(a,id,{amountCents:1}),409,'TRANSACTION_INACTIVE');
    await code(await upload(a,id,'depois'),409,'TRANSACTION_INACTIVE');
    assert.equal(await revision(a),rev+1);
    const got=await (await fetch(base+`/api/v1/transactions/${id}`,{headers:headers(a)})).json();assert.equal(got.status,'EXCLUIDA');
  });

  await t.test('GET lists active and deleted by date and id with cursor; foreign access is 404',async()=>{
    const c=await owner('Synthetic I12 C'),pj=await account(c,'PJ');
    const ids=[await tx(c,pj,{date:'2026-12-03'}),await tx(c,pj,{date:'2026-12-01'}),await tx(c,pj,{date:'2026-12-02'})];
    assert.equal((await del(c,ids[2])).status,200);
    const first=await (await fetch(base+'/api/v1/transactions?periodMonth=2026-12&limit=2',{headers:headers(c)})).json();
    assert.deepEqual(first.items.map(x=>x.transactionId),[ids[1],ids[2]]);assert.equal(first.items[1].status,'EXCLUIDA');assert.equal(first.nextCursor,`2026-12-02_${ids[2]}`);
    assert.equal(first.revision,await revision(c));
    const second=await (await fetch(base+`/api/v1/transactions?periodMonth=2026-12&limit=2&cursor=${first.nextCursor}`,{headers:headers(c)})).json();
    assert.deepEqual(second.items.map(x=>x.transactionId),[ids[0]]);assert.equal(second.nextCursor,null);
    assert.equal((await patch(c,ids[1],{occurredOn:'2026-12-28'})).status,200);
    const stable=await (await fetch(base+`/api/v1/transactions?periodMonth=2026-12&limit=5&cursor=${first.nextCursor}`,{headers:headers(c)})).json();
    assert.deepEqual(stable.items.map(x=>x.transactionId),[ids[0],ids[1]],'cursor keeps its position after an edit between pages');
    assert.notEqual(stable.revision,first.revision,'clients detect pages read from different revisions');
    assert.equal((await (await fetch(base+'/api/v1/transactions?periodMonth=2026-12',{headers:headers(a)})).json()).items.length,0);
    assert.equal((await (await fetch(base+`/api/v1/transactions?periodMonth=2026-12&cursor=2026-12-01_${ids[0]}`,{headers:headers(a)})).json()).items.length,0,'foreign cursor opens nothing');
    await code(await fetch(base+`/api/v1/transactions?periodMonth=2026-12&cursor=2026-11-01_${ids[0]}`,{headers:headers(c)}),404,'NOT_FOUND');
    await code(await fetch(base+`/api/v1/transactions?periodMonth=2026-12&cursor=${ids[0]}`,{headers:headers(c)}),400);
    await code(await fetch(base+`/api/v1/transactions/${ids[0]}`,{headers:headers(a)}),404,'NOT_FOUND');
    for(const q of ['','periodMonth=2026-13','periodMonth=2026-12&limit=0','periodMonth=2026-12&limit=201','periodMonth=2026-12&x=1'])
      assert.ok([400,422].includes((await fetch(base+`/api/v1/transactions?${q}`,{headers:headers(c)})).status),q);
    assert.equal((await fetch(base+'/api/v1/transactions?periodMonth=2026-12')).status,401);
    assert.equal((await fetch(base+`/api/v1/transactions/${ids[0]}`,{method:'PUT',headers:json(c),body:'{}'})).status,405);
  });

  await t.test('captured deliveries stay byte-identical; a new version reflects correction and deletion and verifies offline',async()=>{
    const d=await owner('Synthetic I12 D'),pj=await account(d,'PJ');
    const keep=await tx(d,pj,{date:'2026-09-05',amount:1000,classification:'TRANSFERENCIA',category:'MOVIMENTO'}),drop=await tx(d,pj,{date:'2026-09-06',amount:2000,classification:'TRANSFERENCIA',category:'MOVIMENTO'});
    const worker=new DeliveryExecutor(executorPort,{workRoot,pollMs:50,renewMs:50});
    async function capture(reason=''){
      const r=await fetch(base+'/api/v1/deliveries',{method:'POST',headers:{...json(d),'Idempotency-Key':randomUUID()},body:JSON.stringify({periodMonth:'2026-09',expectedRevision:await revision(d),rectificationReason:reason})});
      assert.equal(r.status,202);const op=await r.json();
      for(let i=0;i<80;i++){const s=await (await fetch(base+`/api/v1/operations/${op.id}`,{headers:headers(d)})).json();if(s.status==='PRONTA')return op;assert.notEqual(s.status,'FALHA');await worker.tick();await sleep(60);}
      assert.fail('delivery not ready');
    }
    const download=async(op,kind)=>Buffer.from(await (await fetch(base+`/api/v1/deliveries/${op.snapshotId}/${kind}`,{headers:headers(d)})).arrayBuffer());
    const v1=await capture(),v1Zip=await download(v1,'package'),v1Manifest=await download(v1,'manifest');
    assert.equal((await patch(d,keep,{amountCents:1500})).status,200);assert.equal((await del(d,drop)).status,200);
    assert.ok((await download(v1,'package')).equals(v1Zip));assert.ok((await download(v1,'manifest')).equals(v1Manifest));
    const v2=await capture('Correção de valor e exclusão de duplicidade'),manifest=JSON.parse((await download(v2,'manifest')).toString('utf8'));
    assert.deepEqual(manifest.transactions.map(x=>[x.transactionId,x.amountCents]),[[keep,1500]]);
    assert.deepEqual(manifest.summary.categoryTotals,[{category:'MOVIMENTO',inflowCents:0,outflowCents:1500,netCents:-1500}]);
    const root=await mkdtemp(join(tmpdir(),'mimir-i12-verify-'));
    try{
      for(const [name,data] of readZip(await download(v2,'package'))){const dest=join(root,'pkg',name);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,data);}
      await writeFile(join(root,'ref.json'),await download(v2,'manifest'));
      const verified=await verifyDeliveryPackage(join(root,'pkg'),join(root,'ref.json'));assert.equal(verified.ok,true,verified.message);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
