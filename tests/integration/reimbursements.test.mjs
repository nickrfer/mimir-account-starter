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

test('I11 reimbursements: HTTP, PostgreSQL, preview, capture and offline verification',async t=>{
  const module=await import('../../apps/api/dist/adapters/postgres-reimbursements.js').catch(()=>null);
  assert.ok(module,'I11 reimbursement adapter missing');
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  const url=new URL(process.env.MIGRATION_DATABASE_URL);url.username='mimir_runtime';url.password=process.env.APP_ROLE_PASSWORD;
  const runtimeUrl=url.toString(),runtime=new pg.Client({connectionString:runtimeUrl}),runtime2=new pg.Client({connectionString:runtimeUrl});
  await runtime.connect();await runtime2.connect();
  const auth=new PostgresAuthentication(runtimeUrl),persistence=new PostgresPersistence(runtimeUrl),accounts=new PostgresAccounts(runtimeUrl);
  const transactions=new PostgresTransactions(runtimeUrl),documents=new PostgresDocuments(runtimeUrl),preview=new PostgresPreview(runtimeUrl);
  const deliveries=new PostgresDeliveries(runtimeUrl),reimbursements=new module.PostgresReimbursements(runtimeUrl);
  const scope=new Set(),executorPort=new PostgresExecutor(runtimeUrl,scope),workRoot=await mkdtemp(join(tmpdir(),'mimir-i11-work-'));
  const service=await AuthenticationService.create(auth),origin='http://127.0.0.1:3000';
  const server=createApp(persistence,fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),{service,origins:new Set([origin]),allowLocalHttp:true,log:()=>{}},
    accounts,transactions,documents,preview,deliveries,reimbursements);
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));
    await Promise.all([admin.end(),runtime.end(),runtime2.end(),auth.close(),persistence.close(),accounts.close(),transactions.close(),documents.close(),preview.close(),deliveries.close(),reimbursements.close(),executorPort.close()]);
    await rm(workRoot,{recursive:true,force:true});});

  const password=randomBytes(24).toString('hex');
  async function owner(label){
    const email=`${randomUUID()}@example.invalid`,identity=await createOwner({email,password,displayName:label,companyName:label});scope.add(identity.workspaceId);
    const r=await fetch(base+'/api/v1/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);
    return {...identity,token:r.headers.get('set-cookie').match(/^mimir_session=([a-f0-9]{64});/)[1],csrf:(await r.json()).csrfToken};
  }
  const headers=(who,extra={})=>({Origin:origin,Cookie:`mimir_session=${who.token}`,'X-CSRF-Token':who.csrf,...extra});
  const json=(who)=>headers(who,{'Content-Type':'application/json'});
  const revision=async who=>Number((await admin.query('SELECT revision::text n FROM mimir.workspaces WHERE id=$1',[who.workspaceId])).rows[0].n);
  async function account(who,type){
    const r=await fetch(base+'/api/v1/accounts',{method:'POST',headers:json(who),body:JSON.stringify({name:`Synthetic ${type} ${randomUUID()}`,accountType:type,expectedRevision:await revision(who)})});
    assert.equal(r.status,201);return (await r.json()).account.id;
  }
  async function tx(who,accountId,fields){
    const body={accountId,occurredOn:fields.date,direction:fields.direction??'SAIDA',amountCents:fields.amount??10000,description:fields.description??'Synthetic I11',
      category:fields.category??'GERAL',classification:fields.classification??'DESPESA',isPfBusinessExpense:fields.business??false,explanation:'',expectedRevision:await revision(who)};
    const r=await fetch(base+'/api/v1/transactions',{method:'POST',headers:json(who),body:JSON.stringify(body)});assert.equal(r.status,201,await r.clone().text());
    return (await r.json()).transaction.transactionId;
  }
  async function upload(who,id,label){
    const body=new FormData();body.append('file',new Blob([Buffer.from(`%PDF-1.7\nSynthetic I11 ${label}\n%%EOF\n`)],{type:'application/pdf'}),`${label}.pdf`);
    body.append('expectedRevision',String(await revision(who)));
    const r=await fetch(base+`/api/v1/transactions/${id}/documents`,{method:'POST',headers:headers(who),body});assert.equal(r.status,201);return (await r.json()).documentId;
  }
  const link=async(who,body,rev)=>fetch(base+'/api/v1/reimbursements',{method:'POST',headers:json(who),
    body:JSON.stringify({pfInflowTransactionId:null,notes:'',...body,expectedRevision:rev??await revision(who)})});
  const undo=async(who,id,rev)=>fetch(base+`/api/v1/reimbursements/${id}`,{method:'DELETE',headers:json(who),body:JSON.stringify({expectedRevision:rev??await revision(who)})});
  const readPreview=async(who,month)=>{const r=await fetch(base+`/api/v1/periods/${month}/preview`,{headers:headers(who)});assert.equal(r.status,200);return r.json();};
  const pending=async(id,type='REEMBOLSO_PF_PENDENTE')=>(await admin.query('SELECT status,justification FROM mimir.pending_items WHERE transaction_id=$1 AND type=$2',[id,type])).rows[0];
  const worker=new DeliveryExecutor(executorPort,{workRoot,pollMs:50,renewMs:50});
  async function capture(who,month,reason=''){
    const r=await fetch(base+'/api/v1/deliveries',{method:'POST',headers:{...json(who),'Idempotency-Key':randomUUID()},
      body:JSON.stringify({periodMonth:month,expectedRevision:await revision(who),rectificationReason:reason})});
    return r;
  }
  async function ready(who,operation){
    for(let i=0;i<80;i++){
      const state=await (await fetch(base+`/api/v1/operations/${operation.id}`,{headers:headers(who)})).json();
      if(state.status==='PRONTA')return state;
      assert.notEqual(state.status,'FALHA',state.errorCode);
      await worker.tick();await sleep(60);
    }
    assert.fail('delivery did not become ready');
  }
  const download=async(who,snapshotId,kind)=>{const r=await fetch(base+`/api/v1/deliveries/${snapshotId}/${kind}`,{headers:headers(who)});assert.equal(r.status,200);return Buffer.from(await r.arrayBuffer());};
  async function verify(zip,manifest){
    const root=await mkdtemp(join(tmpdir(),'mimir-i11-verify-'));
    try{
      for(const [name,data] of readZip(zip)){const dest=join(root,'pkg',name);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,data);}
      await writeFile(join(root,'ref.manifesto.json'),manifest);
      return await verifyDeliveryPackage(join(root,'pkg'),join(root,'ref.manifesto.json'));
    }finally{await rm(root,{recursive:true,force:true});}
  }

  const a=await owner('Synthetic I11 A'),b=await owner('Synthetic I11 B');
  const pfA=await account(a,'PF'),pf2A=await account(a,'PF'),pjA=await account(a,'PJ'),pjB=await account(b,'PJ');

  await t.test('database: privileges, composite FKs, participant trigger, active uniqueness and one-way transition',async()=>{
    const expense=await tx(a,pfA,{date:'2025-03-10',business:true}),outflow=await tx(a,pjA,{date:'2025-03-12',classification:'TRANSFERENCIA'});
    const foreignOut=await tx(b,pjB,{date:'2025-03-12',classification:'TRANSFERENCIA'});
    const insert=(client,fields)=>client.query(`INSERT INTO mimir.reimbursement_links(id,workspace_id,pf_expense_id,pj_outflow_id,pf_inflow_id,amount_cents)
      VALUES($1,$2,$3,$4,$5,$6)`,[fields.id??randomUUID(),fields.workspace??a.workspaceId,fields.expense??expense,fields.outflow??outflow,fields.inflow??null,fields.amount??10000]);
    await assert.rejects(insert(runtime,{amount:9999}),e=>e.code==='23514');
    await assert.rejects(insert(runtime,{outflow:foreignOut}),e=>e.code==='23514','participant lookup is scoped to the link workspace');
    const fks=(await admin.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='mimir.reimbursement_links'::regclass AND contype='f' ORDER BY 1`)).rows.map(r=>r.d);
    for(const column of ['pf_expense_id','pj_outflow_id','pf_inflow_id'])
      assert.ok(fks.includes(`FOREIGN KEY (workspace_id, ${column}) REFERENCES mimir.transactions(workspace_id, id) ON DELETE RESTRICT`),column);
    await assert.rejects(insert(runtime,{expense:outflow,outflow:expense}),e=>e.code==='23514');
    const id=randomUUID();await insert(runtime,{id});
    await assert.rejects(insert(runtime,{}),e=>e.code==='23505');
    await assert.rejects(runtime.query('DELETE FROM mimir.reimbursement_links WHERE id=$1',[id]),e=>e.code==='42501');
    await assert.rejects(runtime.query('TRUNCATE mimir.reimbursement_links'),e=>e.code==='42501');
    await assert.rejects(runtime.query('UPDATE mimir.reimbursement_links SET pj_outflow_id=$2 WHERE id=$1',[id,expense]),e=>e.code==='42501');
    await assert.rejects(runtime.query("UPDATE mimir.reimbursement_links SET status='DESFEITO' WHERE id=$1",[id]),e=>e.code==='23514');
    await runtime.query("UPDATE mimir.reimbursement_links SET status='DESFEITO',undone_at=clock_timestamp() WHERE id=$1",[id]);
    await assert.rejects(runtime.query("UPDATE mimir.reimbursement_links SET status='ATIVO',undone_at=NULL WHERE id=$1",[id]),e=>e.code==='23514');
    await insert(runtime,{});
    assert.equal((await admin.query("SELECT count(*)::int n FROM mimir.schema_migrations WHERE version='008_reimbursement_links.sql'")).rows[0].n,1);
  });

  await t.test('database: linked movements cannot change material facts or be excluded while the link is active',async()=>{
    const expense=await tx(a,pfA,{date:'2025-05-10',business:true,amount:333}),outflow=await tx(a,pjA,{date:'2025-05-11',classification:'TRANSFERENCIA',amount:333});
    const id=randomUUID();
    await runtime.query('INSERT INTO mimir.reimbursement_links(id,workspace_id,pf_expense_id,pj_outflow_id,amount_cents) VALUES($1,$2,$3,$4,333)',[id,a.workspaceId,expense,outflow]);
    for(const [column,value] of [['amount_cents','334'],['occurred_on','2025-05-12'],['classification','A_ESCLARECER'],['is_pf_business_expense','false'],['status','EXCLUIDA']])
      await assert.rejects(runtime.query(`UPDATE mimir.transactions SET ${column}=$2 WHERE id=$1`,[expense,value]),e=>e.code==='23514',column);
    await assert.rejects(runtime.query("UPDATE mimir.transactions SET status='EXCLUIDA' WHERE id=$1",[outflow]),e=>e.code==='23514');
    await runtime.query("UPDATE mimir.transactions SET description='Texto editado' WHERE id=$1",[expense]);
    await runtime.query("UPDATE mimir.reimbursement_links SET status='DESFEITO',undone_at=clock_timestamp() WHERE id=$1",[id]);
    await runtime.query('UPDATE mimir.transactions SET amount_cents=334 WHERE id=$1',[expense]);
  });

  await t.test('database: concurrent inserts for the same PJ outflow admit exactly one active link',async()=>{
    const e1=await tx(a,pfA,{date:'2025-04-01',business:true,amount:777}),e2=await tx(a,pfA,{date:'2025-04-02',business:true,amount:777});
    const outflow=await tx(a,pjA,{date:'2025-04-03',classification:'TRANSFERENCIA',amount:777});
    await runtime.query('BEGIN');await runtime2.query('BEGIN');
    const sql=`INSERT INTO mimir.reimbursement_links(id,workspace_id,pf_expense_id,pj_outflow_id,amount_cents) VALUES($1,$2,$3,$4,777)`;
    await runtime.query(sql,[randomUUID(),a.workspaceId,e1,outflow]);
    const second=runtime2.query(sql,[randomUUID(),a.workspaceId,e2,outflow]);
    await runtime.query('COMMIT');
    await assert.rejects(second,e=>e.code==='23505');await runtime2.query('ROLLBACK');
    assert.equal((await admin.query("SELECT count(*)::int n FROM mimir.reimbursement_links WHERE pj_outflow_id=$1 AND status='ATIVO'",[outflow])).rows[0].n,1);
  });

  let sameMonthLink;
  await t.test('POST links a same-month reimbursement: one revision, pending resolved, no double expense',async()=>{
    const expense=await tx(a,pfA,{date:'2026-10-10',business:true,category:'INFRAESTRUTURA'});
    const outflow=await tx(a,pjA,{date:'2026-10-20',classification:'TRANSFERENCIA',category:'TRANSFERENCIAS'});
    const before=await readPreview(a,'2026-10');
    assert.equal(before.transactions.find(x=>x.transactionId===expense).reimbursementStatus,'PENDENTE_REEMBOLSO');
    const rev=await revision(a);
    const r=await link(a,{pfExpenseTransactionId:expense,pjReimbursementTransactionId:outflow,notes:'  Reembolso de outubro  '},rev);
    assert.equal(r.status,201);const body=await r.json();
    assert.equal(body.revision,rev+1);assert.equal(await revision(a),rev+1);
    assert.deepEqual(Object.keys(body.reimbursement).sort(),['amountCents','createdAt','notes','pfExpenseTransactionId','pfInflowTransactionId','pjReimbursementTransactionId','reimbursementLinkId','status','undoneAt']);
    assert.equal(body.reimbursement.status,'ATIVO');assert.equal(body.reimbursement.amountCents,10000);assert.equal(body.reimbursement.notes,'Reembolso de outubro');
    assert.deepEqual(await pending(expense),{status:'RESOLVIDA',justification:''});
    const after=await readPreview(a,'2026-10');
    assert.equal(after.revision,rev+1);assert.deepEqual(after.contextTransactions,[]);
    assert.deepEqual(after.reimbursementLinks,[{reimbursementLinkId:body.reimbursement.reimbursementLinkId,pfExpenseTransactionId:expense,pjReimbursementTransactionId:outflow,
      pfInflowTransactionId:null,amountCents:10000,pfOriginDocumentIds:[],roleInPeriod:'AMBOS_NO_PERIODO'}]);
    assert.equal(after.transactions.find(x=>x.transactionId===expense).reimbursementStatus,'REEMBOLSADA_NO_MES');
    assert.equal(after.transactions.find(x=>x.transactionId===outflow).reimbursementStatus,'LIQUIDACAO_DE_REEMBOLSO');
    assert.equal(after.summary.businessExpenseTotalCents,10000);assert.equal(after.summary.reimbursementsSettledInPeriodCents,10000);
    assert.deepEqual(after.summary.categoryTotals,before.summary.categoryTotals);assert.deepEqual(after.summary.cashFlowByAccount,before.summary.cashFlowByAccount);
    assert.equal(after.summary.pendingCount,before.summary.pendingCount-1);
    sameMonthLink=body.reimbursement;
  });

  await t.test('POST rejects auth, origin, foreign, stale, invalid, duplicated, inactive and already linked participants without side effects',async()=>{
    const expense=await tx(a,pfA,{date:'2026-09-10',business:true}),outflow=await tx(a,pjA,{date:'2026-09-12',classification:'TRANSFERENCIA'});
    const body={pfExpenseTransactionId:expense,pjReimbursementTransactionId:outflow,pfInflowTransactionId:null,notes:''};
    const rev=await revision(a),status=async(r,code,s)=>{assert.equal(r.status,s);if(code)assert.equal((await r.json()).code,code);};
    await status(await fetch(base+'/api/v1/reimbursements',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({...body,expectedRevision:rev})}),null,401);
    await status(await fetch(base+'/api/v1/reimbursements',{method:'POST',headers:{...json(a),'X-CSRF-Token':'0'.repeat(64)},body:JSON.stringify({...body,expectedRevision:rev})}),null,403);
    await status(await fetch(base+'/api/v1/reimbursements',{method:'POST',headers:{...json(a),Origin:'http://evil.invalid'},body:JSON.stringify({...body,expectedRevision:rev})}),null,403);
    await status(await link(b,body),'NOT_FOUND',404);
    await status(await link(a,{...body,pjReimbursementTransactionId:randomUUID()}),'NOT_FOUND',404);
    await status(await link(a,body,rev-1),'REVISION_CONFLICT',409);
    await status(await link(a,{...body,extra:true}),'INVALID_INPUT',422);
    await status(await link(a,{...body,pjReimbursementTransactionId:expense}),'INVALID_INPUT',422);
    await status(await link(a,{...body,notes:'x'.repeat(2001)}),'INVALID_INPUT',422);
    const wrongAmount=await tx(a,pjA,{date:'2026-09-12',classification:'TRANSFERENCIA',amount:9999});
    await status(await link(a,{...body,pjReimbursementTransactionId:wrongAmount}),'REIMBURSEMENT_AMOUNT_MISMATCH',422);
    const early=await tx(a,pjA,{date:'2026-09-09',classification:'TRANSFERENCIA'});
    await status(await link(a,{...body,pjReimbursementTransactionId:early}),'REIMBURSEMENT_DATE_ORDER_INVALID',422);
    const pjExpense=await tx(a,pjA,{date:'2026-09-12'});
    await status(await link(a,{...body,pjReimbursementTransactionId:pjExpense}),'REIMBURSEMENT_INVALID_PJ_OUTFLOW',422);
    const personal=await tx(a,pfA,{date:'2026-09-10'});
    await status(await link(a,{...body,pfExpenseTransactionId:personal}),'REIMBURSEMENT_INVALID_PF_EXPENSE',422);
    assert.equal(await revision(a),rev+4,'only the four helper transactions changed revision');
    const lateOutflow=await tx(a,pjA,{date:'2026-10-25',classification:'TRANSFERENCIA'});
    const beforeConflicts=await revision(a);
    await status(await link(a,{...body,pfExpenseTransactionId:sameMonthLink.pfExpenseTransactionId,pjReimbursementTransactionId:lateOutflow}),'REIMBURSEMENT_PARTICIPANT_LINKED',409);
    await status(await link(a,{...body,pjReimbursementTransactionId:sameMonthLink.pjReimbursementTransactionId}),'REIMBURSEMENT_PARTICIPANT_LINKED',409);
    const deleted=await tx(a,pjA,{date:'2026-09-12',classification:'TRANSFERENCIA'});
    await admin.query("UPDATE mimir.transactions SET status='EXCLUIDA' WHERE id=$1",[deleted]);
    await status(await link(a,{...body,pjReimbursementTransactionId:deleted}),'TRANSACTION_INACTIVE',409);
    assert.equal(await revision(a),beforeConflicts+1,'only the deleted helper transaction changed revision');
    assert.equal((await admin.query('SELECT count(*)::int n FROM mimir.reimbursement_links WHERE pf_expense_id=$1',[expense])).rows[0].n,0);
    assert.deepEqual(await pending(expense),{status:'PENDENTE',justification:''});
  });

  await t.test('POST reopens justified automatic pending items of participants as a material change',async()=>{
    const expense=await tx(a,pfA,{date:'2026-08-10',business:true}),outflow=await tx(a,pjA,{date:'2026-08-11',classification:'TRANSFERENCIA'});
    await admin.query("UPDATE mimir.pending_items SET status='JUSTIFICADA',justification='Comprovante extraviado' WHERE transaction_id=$1 AND type='DOCUMENTO_AUSENTE'",[expense]);
    assert.equal((await link(a,{pfExpenseTransactionId:expense,pjReimbursementTransactionId:outflow})).status,201);
    assert.deepEqual(await pending(expense,'DOCUMENTO_AUSENTE'),{status:'PENDENTE',justification:''});
    assert.deepEqual(await pending(expense),{status:'RESOLVIDA',justification:''});
  });

  await t.test('concurrent HTTP links for the same PJ outflow: exactly one 201, the other 409 without extra revision',async()=>{
    const e1=await tx(a,pfA,{date:'2026-07-01',business:true,amount:4321}),e2=await tx(a,pfA,{date:'2026-07-02',business:true,amount:4321});
    const outflow=await tx(a,pjA,{date:'2026-07-03',classification:'TRANSFERENCIA',amount:4321});
    const rev=await revision(a);
    const results=await Promise.all([link(a,{pfExpenseTransactionId:e1,pjReimbursementTransactionId:outflow},rev),link(a,{pfExpenseTransactionId:e2,pjReimbursementTransactionId:outflow},rev)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
    assert.equal(await revision(a),rev+1);
    assert.equal((await admin.query("SELECT count(*)::int n FROM mimir.reimbursement_links WHERE pj_outflow_id=$1 AND status='ATIVO'",[outflow])).rows[0].n,1);
  });

  await t.test('cross-month link with PF inflow: context of one hop, settled only in the PJ month, old delivery preserved, new versions verified',async()=>{
    const c=await owner('Synthetic I11 C'),pf=await account(c,'PF'),pj=await account(c,'PJ');
    const expense=await tx(c,pf,{date:'2026-10-10',business:true,category:'INFRAESTRUTURA',description:'Servidor pago na PF'});
    const revenue=await tx(c,pj,{date:'2026-10-12',direction:'ENTRADA',classification:'RECEITA',amount:200000,category:'SERVICOS'});
    const expenseDoc=await upload(c,expense,'origem');await upload(c,revenue,'receita');
    const october1=await capture(c,'2026-10');assert.equal(october1.status,202);const op1=await october1.json();await ready(c,op1);
    const v1Zip=await download(c,op1.snapshotId,'package'),v1Manifest=await download(c,op1.snapshotId,'manifest');
    const v1Payload=(await admin.query('SELECT payload::text p FROM mimir.delivery_snapshots WHERE id=$1',[op1.snapshotId])).rows[0].p;
    const octoberBefore=await readPreview(c,'2026-10');
    const outflow=await tx(c,pj,{date:'2026-11-05',classification:'TRANSFERENCIA',category:'TRANSFERENCIAS',description:'Reembolso PF'});
    const inflow=await tx(c,pf,{date:'2026-11-06',direction:'ENTRADA',classification:'TRANSFERENCIA',category:'TRANSFERENCIAS',description:'Entrada do reembolso'});
    const outflowDoc=await upload(c,outflow,'transferencia');
    const otherPf=await account(c,'PF'),wrongInflow=await tx(c,otherPf,{date:'2026-11-06',direction:'ENTRADA',classification:'TRANSFERENCIA'});
    const earlyInflow=await tx(c,pf,{date:'2026-11-04',direction:'ENTRADA',classification:'TRANSFERENCIA'});
    const base1={pfExpenseTransactionId:expense,pjReimbursementTransactionId:outflow};
    for(const [id,code] of [[wrongInflow,'REIMBURSEMENT_INVALID_PF_INFLOW'],[earlyInflow,'REIMBURSEMENT_DATE_ORDER_INVALID'],[revenue,'REIMBURSEMENT_INVALID_PF_INFLOW']]){
      const r=await link(c,{...base1,pfInflowTransactionId:id});assert.equal(r.status,422);assert.equal((await r.json()).code,code);
    }
    const created=await link(c,{...base1,pfInflowTransactionId:inflow});assert.equal(created.status,201);const linkId=(await created.json()).reimbursement.reimbursementLinkId;

    const november=await readPreview(c,'2026-11');
    assert.deepEqual(november.transactions.map(x=>x.transactionId).sort(),[outflow,inflow,wrongInflow,earlyInflow].sort());
    assert.deepEqual(november.contextTransactions.map(x=>x.transactionId),[expense]);
    assert.equal(november.contextTransactions[0].reimbursementStatus,'REEMBOLSADA_OUTRO_MES');
    assert.deepEqual(november.contextTransactions[0].documentIds,[expenseDoc]);
    assert.equal(november.reimbursementLinks.length,1);assert.equal(november.reimbursementLinks[0].roleInPeriod,'REEMBOLSO_PJ_NO_PERIODO');
    assert.deepEqual(november.reimbursementLinks[0].pfOriginDocumentIds,[expenseDoc]);
    assert.equal(november.summary.reimbursementsSettledInPeriodCents,10000);assert.equal(november.summary.businessExpenseTotalCents,0);
    assert.ok(!november.summary.categoryTotals.some(x=>x.category==='INFRAESTRUTURA'),'context never feeds category totals');
    assert.ok(!november.pendingItems.some(x=>x.transactionId===expense),'pending items only reference principal movements');

    const october=await readPreview(c,'2026-10');
    assert.deepEqual(october.contextTransactions.map(x=>x.transactionId),[outflow,inflow]);
    assert.equal(october.reimbursementLinks[0].roleInPeriod,'DESPESA_ORIGEM_NO_PERIODO');
    assert.equal(october.summary.reimbursementsSettledInPeriodCents,0);
    assert.deepEqual(october.summary.categoryTotals,octoberBefore.summary.categoryTotals);
    assert.deepEqual(october.summary.cashFlowByAccount,octoberBefore.summary.cashFlowByAccount);
    assert.equal(october.summary.businessExpenseTotalCents,10000);
    assert.equal(october.transactions.find(x=>x.transactionId===expense).reimbursementStatus,'REEMBOLSADA_OUTRO_MES');

    const noReason=await capture(c,'2026-10');assert.equal(noReason.status,422);
    const october2=await capture(c,'2026-10','Inclui o reembolso liquidado em novembro');assert.equal(october2.status,202);const op2=await october2.json();assert.equal(op2.versionNumber,2);
    const november1=await capture(c,'2026-11');assert.equal(november1.status,202);const op3=await november1.json();
    await ready(c,op2);await ready(c,op3);
    for(const op of [op2,op3]){
      const zip=await download(c,op.snapshotId,'package'),manifest=await download(c,op.snapshotId,'manifest');
      const verified=await verify(zip,manifest);assert.equal(verified.ok,true,verified.message);
      const parsed=JSON.parse(manifest.toString('utf8'));assert.equal(parsed.reimbursementLinks[0].reimbursementLinkId,linkId);
      const csv=readZip(zip).get('movimentacoes.csv').toString('utf8');
      for(const context of parsed.contextTransactions)assert.ok(!csv.includes(context.transactionId),'context stays out of the monthly CSV');
    }
    const v2=JSON.parse((await download(c,op2.snapshotId,'manifest')).toString('utf8'));
    assert.deepEqual(v2.files.find(f=>f.documentId===outflowDoc).inclusionReasons,['CONTEXTO_REEMBOLSO']);
    assert.deepEqual(v2.summary.categoryTotals,JSON.parse(v1Manifest.toString('utf8')).summary.categoryTotals,'October totals equal before and after the link');
    assert.ok((await download(c,op1.snapshotId,'package')).equals(v1Zip),'v1 package bytes unchanged');
    assert.ok((await download(c,op1.snapshotId,'manifest')).equals(v1Manifest),'v1 manifest bytes unchanged');
    const v1Verified=await verify(v1Zip,v1Manifest);assert.equal(v1Verified.ok,true,v1Verified.message);
    assert.deepEqual(JSON.parse(v1Manifest.toString('utf8')).reimbursementLinks,[]);

    const undone=await undo(c,linkId);assert.equal(undone.status,200);
    assert.equal((await admin.query('SELECT payload::text p FROM mimir.delivery_snapshots WHERE id=$1',[op1.snapshotId])).rows[0].p,v1Payload);
    const v2After=await download(c,op2.snapshotId,'manifest');assert.equal(JSON.parse(v2After.toString('utf8')).reimbursementLinks.length,1,'v2 keeps the link captured at its revision');
  });

  await t.test('only the optional PF inflow in the month: ENTRADA_PF_NO_PERIODO, no settlement and no new expense',async()=>{
    const d=await owner('Synthetic I11 D'),pf=await account(d,'PF'),pj=await account(d,'PJ');
    const expense=await tx(d,pf,{date:'2026-10-10',business:true}),outflow=await tx(d,pj,{date:'2026-10-30',classification:'TRANSFERENCIA'});
    const inflow=await tx(d,pf,{date:'2026-11-02',direction:'ENTRADA',classification:'TRANSFERENCIA',category:'TRANSFERENCIAS'});
    assert.equal((await link(d,{pfExpenseTransactionId:expense,pjReimbursementTransactionId:outflow,pfInflowTransactionId:inflow})).status,201);
    const november=await readPreview(d,'2026-11');
    assert.deepEqual(november.transactions.map(x=>x.transactionId),[inflow]);
    assert.deepEqual(november.contextTransactions.map(x=>x.transactionId),[expense,outflow]);
    assert.equal(november.reimbursementLinks[0].roleInPeriod,'ENTRADA_PF_NO_PERIODO');
    assert.equal(november.transactions[0].reimbursementStatus,'LIQUIDACAO_DE_REEMBOLSO');
    assert.equal(november.summary.reimbursementsSettledInPeriodCents,0);assert.equal(november.summary.businessExpenseTotalCents,0);
    assert.deepEqual(november.summary.cashFlowByAccount.map(x=>[x.accountId,x.inflowCents,x.outflowCents]),[[pf,10000,0]]);
    const october=await readPreview(d,'2026-10');
    assert.equal(october.reimbursementLinks[0].roleInPeriod,'AMBOS_NO_PERIODO');assert.equal(october.summary.reimbursementsSettledInPeriodCents,10000);
    assert.equal(october.transactions.find(x=>x.transactionId===expense).reimbursementStatus,'REEMBOLSADA_NO_MES');
  });

  await t.test('DELETE undoes logically: history kept, pending reopened, one revision, idempotent rejection and relink',async()=>{
    const expense=sameMonthLink.pfExpenseTransactionId,id=sameMonthLink.reimbursementLinkId;
    await admin.query("UPDATE mimir.pending_items SET status='JUSTIFICADA',justification='Comprovante extraviado' WHERE transaction_id=$1 AND type='DOCUMENTO_AUSENTE'",[expense]);
    const rev=await revision(a);
    assert.equal((await undo(b,id)).status,404);
    assert.equal((await undo(a,id,rev-1)).status,409);
    assert.equal((await fetch(base+`/api/v1/reimbursements/${id}`,{method:'DELETE',headers:{...json(a),'X-CSRF-Token':'0'.repeat(64)},body:JSON.stringify({expectedRevision:rev})})).status,403);
    assert.equal((await undo(a,'not-a-uuid',rev)).status,422);
    assert.equal(await revision(a),rev);
    const r=await undo(a,id,rev);assert.equal(r.status,200);const body=await r.json();
    assert.equal(body.revision,rev+1);assert.equal(body.reimbursement.status,'DESFEITO');assert.ok(body.reimbursement.undoneAt);
    assert.deepEqual(await pending(expense),{status:'PENDENTE',justification:''});
    assert.deepEqual(await pending(expense,'DOCUMENTO_AUSENTE'),{status:'PENDENTE',justification:''});
    const again=await undo(a,id);assert.equal(again.status,409);assert.equal((await again.json()).code,'REIMBURSEMENT_ALREADY_UNDONE');
    assert.equal(await revision(a),rev+1);
    const octoberUndone=await readPreview(a,'2026-10');
    assert.equal(octoberUndone.transactions.find(x=>x.transactionId===expense).reimbursementStatus,'PENDENTE_REEMBOLSO');
    assert.ok(!octoberUndone.reimbursementLinks.some(x=>x.reimbursementLinkId===id));
    const relinked=await link(a,{pfExpenseTransactionId:expense,pjReimbursementTransactionId:sameMonthLink.pjReimbursementTransactionId});
    assert.equal(relinked.status,201);const newId=(await relinked.json()).reimbursement.reimbursementLinkId;assert.notEqual(newId,id);
    const list=await (await fetch(base+'/api/v1/reimbursements?periodMonth=2026-10',{headers:headers(a)})).json();
    const statuses=Object.fromEntries(list.items.filter(x=>[id,newId].includes(x.reimbursementLinkId)).map(x=>[x.reimbursementLinkId,x.status]));
    assert.deepEqual(statuses,{[id]:'DESFEITO',[newId]:'ATIVO'});
    assert.equal(list.nextCursor,null);
    assert.equal((await fetch(base+'/api/v1/reimbursements?periodMonth=2026-10',{headers:headers(b)}).then(x=>x.json())).items.length,0);
  });

  await t.test('GET list paginates by cursor and validates query; candidates list only compatible unlinked choices',async()=>{
    const page=await (await fetch(base+'/api/v1/reimbursements?periodMonth=2025-04&limit=1',{headers:headers(a)})).json();
    assert.equal(page.items.length,1);
    for(const q of ['','periodMonth=2025-13','periodMonth=2025-04&limit=0','periodMonth=2025-04&limit=201','periodMonth=2025-04&x=1'])
      assert.ok([400,422].includes((await fetch(base+`/api/v1/reimbursements?${q}`,{headers:headers(a)})).status),q);
    const unknownCursor=await fetch(base+`/api/v1/reimbursements?periodMonth=2025-04&cursor=${randomUUID()}`,{headers:headers(a)});
    assert.equal(unknownCursor.status,404);assert.equal((await unknownCursor.json()).code,"NOT_FOUND");
    assert.equal((await fetch(base+'/api/v1/reimbursements?periodMonth=2025-04')).status,401);

    const expense=await tx(a,pfA,{date:'2026-06-10',business:true,amount:5555});
    const good=await tx(a,pjA,{date:'2026-06-10',classification:'TRANSFERENCIA',amount:5555}),later=await tx(a,pjA,{date:'2026-07-01',classification:'TRANSFERENCIA',amount:5555});
    const before=await tx(a,pjA,{date:'2026-06-09',classification:'TRANSFERENCIA',amount:5555});await tx(a,pjA,{date:'2026-06-11',classification:'TRANSFERENCIA',amount:5556});
    await tx(a,pjA,{date:'2026-06-11',amount:5555});
    const goodInflow=await tx(a,pfA,{date:'2026-06-12',direction:'ENTRADA',classification:'TRANSFERENCIA',amount:5555});
    await tx(a,pf2A,{date:'2026-06-12',direction:'ENTRADA',classification:'TRANSFERENCIA',amount:5555});
    const r=await fetch(base+`/api/v1/reimbursements/candidates?pfExpenseId=${expense}`,{headers:headers(a)});assert.equal(r.status,200);const candidates=await r.json();
    assert.equal(candidates.pfExpense.transactionId,expense);
    assert.deepEqual(candidates.pjOutflows.map(x=>x.transactionId),[good,later]);
    assert.deepEqual(candidates.pfInflows.map(x=>x.transactionId),[goodInflow]);
    assert.deepEqual(Object.keys(candidates.pjOutflows[0]).sort(),['accountId','accountName','amountCents','categoryOriginal','descriptionOriginal','occurredOn','transactionId']);
    assert.equal((await link(a,{pfExpenseTransactionId:expense,pjReimbursementTransactionId:good})).status,201);
    const linked=await fetch(base+`/api/v1/reimbursements/candidates?pfExpenseId=${expense}`,{headers:headers(a)});assert.equal(linked.status,409);
    const other=await tx(a,pfA,{date:'2026-06-01',business:true,amount:5555});
    const afterLink=await (await fetch(base+`/api/v1/reimbursements/candidates?pfExpenseId=${other}`,{headers:headers(a)})).json();
    assert.deepEqual(afterLink.pjOutflows.map(x=>x.transactionId),[before,later],'linked outflow is no longer offered');
    assert.equal((await fetch(base+`/api/v1/reimbursements/candidates?pfExpenseId=${expense}`,{headers:headers(b)})).status,404);
    assert.equal((await fetch(base+`/api/v1/reimbursements/candidates?pfExpenseId=${good}`,{headers:headers(a)})).status,422);
    assert.equal((await fetch(base+'/api/v1/reimbursements/candidates?pfExpenseId=x',{headers:headers(a)})).status,422);
    assert.equal((await fetch(base+`/api/v1/reimbursements/candidates?pfExpenseId=${expense}&x=1`,{headers:headers(a)})).status,400);
  });

  await t.test('limit of 1000 records includes context transactions',async()=>{
    const e=await owner('Synthetic I11 E'),pf=await account(e,'PF'),pj=await account(e,'PJ');
    const expense=await tx(e,pf,{date:'2027-01-05',business:true}),outflow=await tx(e,pj,{date:'2027-02-01',classification:'TRANSFERENCIA'});
    await admin.query(`INSERT INTO mimir.transactions(id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,description,category,classification,explanation,source_type,source_code,external_id)
      SELECT g.id,$1,$2,'2027-01-10','2027-01','SAIDA',1,'Synthetic bulk','GERAL','TRANSFERENCIA','','MANUAL','MANUAL',g.id::text FROM (SELECT gen_random_uuid() id FROM generate_series(1,999)) g`,[e.workspaceId,pj]);
    assert.equal((await fetch(base+'/api/v1/periods/2027-01/preview',{headers:headers(e)})).status,200);
    assert.equal((await link(e,{pfExpenseTransactionId:expense,pjReimbursementTransactionId:outflow})).status,201);
    const limited=await fetch(base+'/api/v1/periods/2027-01/preview',{headers:headers(e)});assert.equal(limited.status,413);
    assert.equal((await capture(e,'2027-01')).status,413);
  });
});
