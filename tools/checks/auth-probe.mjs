import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
async function checkPreview(cookie,state){
  const response=await fetch('http://api:3000/api/v1/periods/2026-10/preview',{headers:{Cookie:cookie},signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const preview=await response.json();
  assert.equal(preview.periodMonth,'2026-10');assert.equal(preview.revision,4);assert.equal(preview.workspace.workspaceId,state.workspaceId);
  assert.equal(preview.transactions.length,1);assert.equal(preview.contextTransactions.length,0);assert.equal(preview.reimbursementLinks.length,0);
  const transaction=preview.transactions[0];
  assert.equal(transaction.accountId,state.accountId);assert.equal(transaction.transactionId,state.transactionId);
  assert.deepEqual(transaction.documentIds,[state.documentId]);assert.equal(transaction.reimbursementStatus,'PENDENTE_REEMBOLSO');
  assert.deepEqual(preview.summary.cashFlowByAccount.map(({accountType,inflowCents,outflowCents,netCents})=>({accountType,inflowCents,outflowCents,netCents})),[{accountType:'PF',inflowCents:0,outflowCents:1250,netCents:-1250}]);
  assert.equal(preview.summary.businessRevenueTotalCents,0);assert.equal(preview.summary.businessExpenseTotalCents,1250);
  assert.equal(preview.summary.reimbursementsSettledInPeriodCents,0);assert.equal(preview.summary.pendingCount,1);assert.equal(preview.summary.justifiedCount,0);
  assert.deepEqual(preview.summary.categoryTotals,[{category:'Geral',inflowCents:0,outflowCents:1250,netCents:-1250}]);
  assert.deepEqual(preview.pendingItems.map(({pendingType,status})=>({pendingType,status})),[
    {pendingType:'DOCUMENTO_AUSENTE',status:'RESOLVIDA'},{pendingType:'REEMBOLSO_PF_PENDENTE',status:'PENDENTE'}
  ]);
}
async function waitReady(state){
  const url=`http://api:3000/api/v1/operations/${state.deliveryOperation.id}`;
  for(let i=0;i<80;i++){
    const response=await fetch(url,{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);
    const operation=await response.json();if(operation.status==='PRONTA')return operation;assert.notEqual(operation.status,'FALHA');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('Operation did not become PRONTA');
}
async function checkDelivery(state,first){
  const payload={periodMonth:'2026-10',expectedRevision:4,rectificationReason:''};
  const headers={Origin:origin,'Content-Type':'application/json',Cookie:state.cookie,'X-CSRF-Token':state.csrf,'Idempotency-Key':state.deliveryKey};
  const operation=first?await waitReady(state):await (await fetch(`http://api:3000/api/v1/operations/${state.deliveryOperation.id}`,{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(5000)})).json();
  assert.equal(operation.id,state.deliveryOperation.id);assert.equal(operation.snapshotId,state.deliveryOperation.snapshotId);assert.equal(operation.status,'PRONTA');
  assert.equal(operation.attemptCount,1);assert.equal(operation.errorCode,null);assert.ok(operation.completedAt);assert.equal(operation.capturedRevision,4);assert.equal(operation.versionNumber,1);
  assert.deepEqual(Object.keys(operation).sort(),['attemptCount','capturedRevision','completedAt','createdAt','errorCode','id','periodMonth','snapshotId','status','versionNumber']);
  if(!first)assert.deepEqual(operation,state.readyOperation);
  const history=await (await fetch('http://api:3000/api/v1/periods/2026-10/deliveries',{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(5000)})).json();
  assert.ok(history.items.some(item=>JSON.stringify(item)===JSON.stringify(operation)));
  const repeated=await fetch('http://api:3000/api/v1/deliveries',{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(5000)});
  assert.equal(repeated.status,200);assert.deepEqual(await repeated.json(),operation);
  const zipResponse=await fetch(`http://api:3000/api/v1/deliveries/${operation.snapshotId}/package`,{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(10000)});
  assert.equal(zipResponse.status,200);assert.equal(zipResponse.headers.get('content-type'),'application/zip');
  const zip=Buffer.from(await zipResponse.arrayBuffer()),zipHash=createHash('sha256').update(zip).digest('hex');
  assert.equal(zip.subarray(0,4).toString('hex'),'504b0304');assert.equal(zipResponse.headers.get('x-content-sha256'),zipHash);
  const manifestResponse=await fetch(`http://api:3000/api/v1/deliveries/${operation.snapshotId}/manifest`,{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(10000)});
  assert.equal(manifestResponse.status,200);const manifestBytes=Buffer.from(await manifestResponse.arrayBuffer()),manifestHash=createHash('sha256').update(manifestBytes).digest('hex');
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.schemaVersion,'mimir.manifest.v2');assert.equal(manifest.delivery.snapshotId,operation.snapshotId);assert.equal(manifest.delivery.operationId,operation.id);
  assert.equal(manifest.transactions[0].transactionId,state.transactionId);assert.equal(manifest.summary.businessExpenseTotalCents,1250);
  const attachment=manifest.files.find(file=>file.documentId===state.documentId);assert.ok(attachment);assert.equal(attachment.sha256,state.documentHash);assert.deepEqual(manifest.files.map(file=>file.path).sort(),[`anexos/${state.documentId}.pdf`,'movimentacoes.csv','resumo.html']);
  if(first){state.readyOperation=operation;state.zipHash=zipHash;state.manifestHash=manifestHash;}
  else{assert.equal(zipHash,state.zipHash);assert.equal(manifestHash,state.manifestHash);}
  const session=await fetch('http://api:3000/api/v1/session',{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(5000)});
  assert.equal(session.status,200);assert.equal((await session.json()).revision,4);
  const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
  try{
    const stored=(await admin.query('SELECT zip_hash,manifest_hash,published_token::int token FROM mimir.delivery_packages WHERE workspace_id=$1 AND operation_id=$2',[state.workspaceId,operation.id])).rows;
    assert.deepEqual(stored,[{zip_hash:zipHash,manifest_hash:manifestHash,token:1}]);
    const key=(await admin.query('SELECT operation_id FROM mimir.idempotency_keys WHERE workspace_id=$1 AND key=$2',[state.workspaceId,state.deliveryKey])).rows[0];assert.equal(key.operation_id,operation.id);
    const counts=(await admin.query(`SELECT (SELECT count(*)::int FROM mimir.delivery_snapshots WHERE workspace_id=$1) snapshots,
      (SELECT count(*)::int FROM mimir.delivery_operations WHERE workspace_id=$1) operations,(SELECT count(*)::int FROM mimir.idempotency_keys WHERE workspace_id=$1) keys,
      (SELECT count(*)::int FROM mimir.delivery_packages WHERE workspace_id=$1) packages,
      (SELECT fencing_token::int FROM mimir.delivery_operations WHERE workspace_id=$1) token`,[state.workspaceId])).rows[0];assert.deepEqual(counts,{snapshots:1,operations:1,keys:1,packages:1,token:1});
  }finally{await admin.end();}
}
const base='http://api:3000/api/v1/session', origin='http://127.0.0.1:3000';
const path='/probe-state/session.json';
try {
  const mode=process.argv[2];
  if(mode==='create'){
    const password=randomBytes(24).toString('hex');
    const email=`${randomUUID()}@example.invalid`;
    const child=spawnSync(process.execPath,['tools/admin/cli.mjs','create-owner'],{
      input:JSON.stringify({email,password,displayName:'Remote synthetic',companyName:'Remote synthetic'}),encoding:'utf8'});
    assert.equal(child.status,0);
    const owner=JSON.parse(child.stdout);
    const response=await fetch(base,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password}),signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);
    const body=await response.json(), header=response.headers.get('set-cookie');
    const token=/^mimir_session=([a-f0-9]{64});/.exec(header)?.[1];assert.ok(token);
    assert.ok(header.includes('HttpOnly')&&!header.includes('; Secure'));
    assert.equal(body.userId,owner.userId);assert.equal(body.workspace.workspaceId,owner.workspaceId);
    const accountResponse=await fetch('http://api:3000/api/v1/accounts',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:`mimir_session=${token}`,'X-CSRF-Token':body.csrfToken},
      body:JSON.stringify({name:'Remote synthetic PF',accountType:'PF',expectedRevision:body.revision}),signal:AbortSignal.timeout(5000)});
    assert.equal(accountResponse.status,201);const mutation=await accountResponse.json();assert.equal(mutation.revision,2);
    const readAccounts=await fetch('http://api:3000/api/v1/accounts',{headers:{Cookie:`mimir_session=${token}`},signal:AbortSignal.timeout(5000)});
    assert.equal(readAccounts.status,200);assert.equal((await readAccounts.json()).items[0].id,mutation.account.id);
    const transactionResponse=await fetch('http://api:3000/api/v1/transactions',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:`mimir_session=${token}`,'X-CSRF-Token':body.csrfToken},
      body:JSON.stringify({accountId:mutation.account.id,occurredOn:'2026-10-15',direction:'SAIDA',amountCents:1250,description:'Remote synthetic transaction',category:'Geral',classification:'DESPESA',isPfBusinessExpense:true,explanation:'',expectedRevision:mutation.revision}),signal:AbortSignal.timeout(5000)});
    assert.equal(transactionResponse.status,201);const transactionMutation=await transactionResponse.json();assert.equal(transactionMutation.revision,3);
    assert.equal(transactionMutation.transaction.reimbursementStatus,'PENDENTE_REEMBOLSO');
    const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
    try {
      const hash=createHash('sha256').update(token).digest('hex');
      const row=(await admin.query('SELECT token_hash,expires_at FROM mimir.sessions WHERE token_hash=$1',[hash])).rows[0];
      assert.ok(row.token_hash===hash&&row.token_hash!==token);
      const pending=(await admin.query('SELECT type,status,justification FROM mimir.pending_items WHERE workspace_id=$1 AND transaction_id=$2 ORDER BY type',[owner.workspaceId,transactionMutation.transaction.transactionId])).rows;
      assert.deepEqual(pending,[{type:'DOCUMENTO_AUSENTE',status:'PENDENTE',justification:''},{type:'REEMBOLSO_PF_PENDENTE',status:'PENDENTE',justification:''}]);
      const bytes=Buffer.from('%PDF-1.7\nRemote synthetic I05\n%%EOF\n'),form=new FormData();
      form.append('file',new Blob([bytes],{type:'application/pdf'}),'synthetic.pdf');form.append('expectedRevision',String(transactionMutation.revision));
      const upload=await fetch(`http://api:3000/api/v1/transactions/${transactionMutation.transaction.transactionId}/documents`,{method:'POST',headers:{Origin:origin,Cookie:`mimir_session=${token}`,'X-CSRF-Token':body.csrfToken},body:form,signal:AbortSignal.timeout(5000)});
      assert.equal(upload.status,201);const document=await upload.json();assert.equal(document.revision,4);assert.equal(document.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(document.sizeBytes,bytes.length);
      const state={cookie:`mimir_session=${token}`,csrf:body.csrfToken,userId:owner.userId,workspaceId:owner.workspaceId,expiresAt:row.expires_at.toISOString(),revision:document.revision,accountId:mutation.account.id,transactionId:transactionMutation.transaction.transactionId,documentId:document.documentId,documentHash:document.sha256};
      await checkPreview(state.cookie,state);
      const deliveryKey=randomUUID(),deliveryPayload={periodMonth:'2026-10',expectedRevision:4,rectificationReason:''};
      const delivery=await fetch('http://api:3000/api/v1/deliveries',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:state.cookie,'X-CSRF-Token':state.csrf,'Idempotency-Key':deliveryKey},body:JSON.stringify(deliveryPayload),signal:AbortSignal.timeout(5000)});
      assert.equal(delivery.status,202);const deliveryOperation=await delivery.json();
      assert.equal(deliveryOperation.status,'EM_FILA');assert.equal(deliveryOperation.attemptCount,0);assert.equal(deliveryOperation.errorCode,null);
      assert.equal(deliveryOperation.capturedRevision,4);assert.equal(deliveryOperation.versionNumber,1);
      const captured=(await admin.query('SELECT payload FROM mimir.delivery_snapshots WHERE workspace_id=$1 AND id=$2',[owner.workspaceId,deliveryOperation.snapshotId])).rows[0];assert.ok(captured);
      assert.equal(captured.payload.summary.businessExpenseTotalCents,1250);
      assert.ok(captured.payload.documents.some(item=>item.documentId===document.documentId));
      assert.ok(captured.payload.transactions.some(item=>item.transactionId===transactionMutation.transaction.transactionId));
      assert.equal(captured.payload.documents.find(item=>item.documentId===document.documentId).sha256,document.sha256);
      const refs=(await admin.query('SELECT document_id FROM mimir.snapshot_documents WHERE workspace_id=$1 AND snapshot_id=$2 ORDER BY document_id',[owner.workspaceId,deliveryOperation.snapshotId])).rows.map(item=>item.document_id);
      assert.deepEqual(refs,[document.documentId]);
      state.deliveryKey=deliveryKey;state.deliveryOperation=deliveryOperation;
      assert.equal((await fetch(base,{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(5000)})).status,200);
      await checkDelivery(state,true);
      await writeFile(path,JSON.stringify(state),{flag:'wx',mode:0o600});
    }finally{await admin.end();}
  }else{
    const state=JSON.parse(await readFile(path,'utf8'));
    const response=await fetch(base,{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(5000)});
    if(mode==='outage'){
      assert.equal(response.status,500);
      const body=await response.json();assert.equal(body.code,'INTERNAL_ERROR');assert.deepEqual(Object.keys(body).sort(),['code','message','requestId']);
      const operation=await fetch(`http://api:3000/api/v1/operations/${state.deliveryOperation.id}`,{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(5000)});
      assert.equal(operation.status,500);const operationBody=await operation.json();assert.equal(operationBody.code,'INTERNAL_ERROR');assert.deepEqual(Object.keys(operationBody).sort(),['code','message','requestId']);
      const packageOutage=await fetch(`http://api:3000/api/v1/deliveries/${state.deliveryOperation.snapshotId}/package`,{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(5000)});
      assert.equal(packageOutage.status,500);assert.deepEqual(Object.keys(await packageOutage.json()).sort(),['code','message','requestId']);
      const preview=await fetch('http://api:3000/api/v1/periods/2026-10/preview',{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(5000)});
      assert.equal(preview.status,500);const previewBody=await preview.json();assert.equal(previewBody.code,'INTERNAL_ERROR');assert.deepEqual(Object.keys(previewBody).sort(),['code','message','requestId']);
    }else if(mode==='resume'){
      assert.equal(response.status,200);const body=await response.json();assert.equal(body.userId,state.userId);assert.equal(body.revision,state.revision);
      const accounts=await fetch('http://api:3000/api/v1/accounts',{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(5000)});
      assert.equal(accounts.status,200);const page=await accounts.json();assert.equal(page.items.length,1);assert.equal(page.items[0].id,state.accountId);
      const admin=new pg.Client({connectionString:process.env.MIGRATION_DATABASE_URL});await admin.connect();
      try{
        const hash=createHash('sha256').update(state.cookie.slice('mimir_session='.length)).digest('hex');
        const row=(await admin.query('SELECT expires_at FROM mimir.sessions WHERE token_hash=$1',[hash])).rows[0];assert.equal(row.expires_at.toISOString(),state.expiresAt);
        const tx=(await admin.query('SELECT occurred_on::text,amount_cents::text,source_type,source_code,external_id,period_month FROM mimir.transactions WHERE workspace_id=$1 AND id=$2',[state.workspaceId,state.transactionId])).rows[0];
        assert.deepEqual(tx,{occurred_on:'2026-10-15',amount_cents:'1250',source_type:'MANUAL',source_code:'MANUAL',external_id:state.transactionId,period_month:'2026-10'});
        const pending=(await admin.query('SELECT type,status FROM mimir.pending_items WHERE workspace_id=$1 AND transaction_id=$2 ORDER BY type',[state.workspaceId,state.transactionId])).rows;
        assert.deepEqual(pending,[{type:'DOCUMENTO_AUSENTE',status:'RESOLVIDA'},{type:'REEMBOLSO_PF_PENDENTE',status:'PENDENTE'}]);
        const bytes=Buffer.from('%PDF-1.7\nRemote synthetic I05\n%%EOF\n');
        const document=(await admin.query(`SELECT d.bytes,d.hash,d.size_bytes FROM mimir.documents d JOIN mimir.transaction_documents td ON td.workspace_id=d.workspace_id AND td.document_id=d.id
          WHERE d.workspace_id=$1 AND d.id=$2 AND td.transaction_id=$3`,[state.workspaceId,state.documentId,state.transactionId])).rows[0];
        assert.deepEqual(document,{bytes,hash:state.documentHash,size_bytes:bytes.length});assert.equal(createHash('sha256').update(document.bytes).digest('hex'),state.documentHash);
      }finally{await admin.end();}
      await checkPreview(state.cookie,state);
      await checkDelivery(state);
      const logout=await fetch(base,{method:'DELETE',headers:{Cookie:state.cookie,Origin:origin,'X-CSRF-Token':state.csrf},signal:AbortSignal.timeout(5000)});
      assert.equal(logout.status,204);
      assert.equal((await fetch(base,{headers:{Cookie:state.cookie},signal:AbortSignal.timeout(5000)})).status,401);
      await unlink(path);
    }else throw new Error('Invalid probe');
  }
  console.log(`PASS auth=${mode}`);
}catch{console.error('FAIL auth probe');process.exitCode=1;}
