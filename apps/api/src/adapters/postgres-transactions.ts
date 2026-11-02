import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { postgresTypes } from './postgres.js';
import { authorizeActor,lockWorkspace } from './postgres-workspace.js';
import { nextRevision } from '../domain/values.js';
import { ApiError } from '../http/error.js';
import { mergedRulesValid,validateAccount } from '../transactions/input.js';
import { initialPendingTypes,pendingDescriptions } from '../transactions/pending.js';
import { reconcileTransactionPending } from './postgres-pending-reconcile.js';
import type { WorkspaceActor } from '../ports/workspace.js';
import type { CreateTransaction,ManualTransaction,PatchTransaction,TransactionMutation,TransactionPage,TransactionRecord,TransactionsPort } from '../ports/transactions.js';

interface RecordRow {
  id:string; account_id:string; name:string; account_type:'PF'|'PJ'; occurred_on:string; period_month:string; direction:TransactionRecord['direction'];
  amount_cents:number; description:string; category:string; classification:TransactionRecord['classification']; is_pf_business_expense:boolean;
  explanation:string; source_type:'MANUAL'|'CSV'; source_code:string; external_id:string; status:'ATIVA'|'EXCLUIDA';
  document_ids:string[]; reimbursement_link_id:string|null;
}
const recordQuery=`SELECT t.id,t.account_id,a.name,a.account_type,t.occurred_on,t.period_month,t.direction,t.amount_cents,t.description,t.category,
  t.classification,t.is_pf_business_expense,t.explanation,t.source_type,t.source_code,t.external_id,t.status,
  coalesce((SELECT array_agg(td.document_id::text ORDER BY td.document_id) FROM mimir.transaction_documents td
    WHERE td.workspace_id=t.workspace_id AND td.transaction_id=t.id),ARRAY[]::text[]) AS document_ids,
  (SELECT l.id FROM mimir.reimbursement_links l WHERE l.workspace_id=t.workspace_id AND l.status='ATIVO'
    AND t.id IN (l.pf_expense_id,l.pj_outflow_id,l.pf_inflow_id)) AS reimbursement_link_id
  FROM mimir.transactions t JOIN mimir.accounts a ON (a.workspace_id,a.id)=(t.workspace_id,t.account_id)`;
function record(row:RecordRow):TransactionRecord{
  return{transactionId:row.id,accountId:row.account_id,accountName:row.name,accountType:row.account_type,occurredOn:row.occurred_on,periodMonth:row.period_month,
    direction:row.direction,amountCents:row.amount_cents,descriptionOriginal:row.description,categoryOriginal:row.category,classification:row.classification,
    isPfBusinessExpense:row.is_pf_business_expense,explanationOriginal:row.explanation,sourceType:row.source_type,sourceCode:row.source_code,
    externalId:row.external_id,documentIds:row.document_ids,status:row.status,reimbursementLinkId:row.reimbursement_link_id};
}
const notFound=():never=>{throw new ApiError(404,'NOT_FOUND','Objeto não encontrado');};
const linkedConflict=()=>new ApiError(409,'LINKED_TRANSACTION_CONFLICT','Movimentação com vínculo de reembolso ativo');
const materialFields=['accountId','occurredOn','direction','amountCents','classification','isPfBusinessExpense'] as const;

export class PostgresTransactions implements TransactionsPort {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool=new pg.Pool({connectionString:databaseUrl,max:4,types:postgresTypes,application_name:'mimir-transactions',
      connectionTimeoutMillis:1500,query_timeout:1500,idleTimeoutMillis:10000,options:'-c statement_timeout=1500 -c search_path=mimir,pg_catalog'});
    this.pool.on('error',()=>{});
  }
  private async write<T>(actor:WorkspaceActor,work:(client:pg.PoolClient,current:number)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect();let broken=false;
    try{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result=await work(client,await lockWorkspace(client,actor));
      await authorizeActor(client,actor);
      await client.query('COMMIT');return result;
    }catch(error){
      try{await client.query('ROLLBACK');}catch{broken=true;}
      if((error as {code?:string}).code==='23514'&&(error as {message?:string}).message==='Linked transaction cannot change')throw linkedConflict();
      throw error;
    }finally{client.release(broken);}
  }
  private async read<T>(actor:WorkspaceActor,work:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect();let broken=false;
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await authorizeActor(client,actor);
      const result=await work(client);
      await authorizeActor(client,actor);
      await client.query('COMMIT');return result;
    }catch(error){try{await client.query('ROLLBACK');}catch{broken=true;}throw error;}
    finally{client.release(broken);}
  }
  private async load(client:pg.PoolClient,workspaceId:string,id:string,lock=''):Promise<RecordRow|undefined>{
    return(await client.query<RecordRow>(`${recordQuery} WHERE t.workspace_id=$1 AND t.id=$2${lock}`,[workspaceId,id])).rows[0];
  }

  async create(actor: WorkspaceActor, command: CreateTransaction): Promise<{transaction:ManualTransaction;revision:number}> {
    return this.write(actor,async(client,current)=>{
      const result=await client.query<{id:string;name:string;account_type:'PF'|'PJ';active:boolean}>(
        'SELECT id,name,account_type,active FROM mimir.accounts WHERE workspace_id=$1 AND id=$2 FOR SHARE',[actor.workspaceId,command.accountId]);
      const account=result.rows[0];
      if(!account)throw new ApiError(404,'NOT_FOUND','Objeto não encontrado');
      validateAccount(command,{accountType:account.account_type,active:account.active});
      const revision=nextRevision(current,command.expectedRevision),id=randomUUID();
      await client.query(`INSERT INTO mimir.periods(id,workspace_id,period_month) VALUES($1,$2,$3)
        ON CONFLICT(workspace_id,period_month) DO NOTHING`,[randomUUID(),actor.workspaceId,command.periodMonth]);
      const inserted=await client.query<{id:string;occurred_on:string;amount_cents:number}>(`INSERT INTO mimir.transactions
        (id,workspace_id,account_id,occurred_on,period_month,direction,amount_cents,description,category,classification,is_pf_business_expense,explanation,source_type,source_code,external_id)
        VALUES($1::uuid,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,'MANUAL','MANUAL',$1::uuid::text)
        RETURNING id,occurred_on,amount_cents`,[id,actor.workspaceId,account.id,command.occurredOn,command.periodMonth,command.direction,
        command.amountCents,command.description,command.category,command.classification,command.isPfBusinessExpense,command.explanation]);
      for(const type of initialPendingTypes(command))await client.query(`INSERT INTO mimir.pending_items
        (id,workspace_id,transaction_id,type,description) VALUES($1,$2,$3,$4,$5)`,[randomUUID(),actor.workspaceId,id,type,pendingDescriptions[type]]);
      await client.query('UPDATE mimir.workspaces SET revision=$1 WHERE id=$2',[revision,actor.workspaceId]);
      const row=inserted.rows[0]!;
      return{transaction:{transactionId:row.id,accountId:account.id,accountName:account.name,accountType:account.account_type,
        occurredOn:row.occurred_on,direction:command.direction,amountCents:row.amount_cents,descriptionOriginal:command.description,
        categoryOriginal:command.category,classification:command.classification,isPfBusinessExpense:command.isPfBusinessExpense,
        explanationOriginal:command.explanation,sourceType:'MANUAL',sourceCode:'MANUAL',externalId:row.id,documentIds:[],
        reimbursementStatus:command.isPfBusinessExpense?'PENDENTE_REEMBOLSO':'NAO_APLICAVEL'},revision};
    });
  }

  update(actor:WorkspaceActor,id:string,changes:PatchTransaction,expectedRevision:number):Promise<TransactionMutation>{
    return this.write(actor,async(client,current)=>{
      const row=await this.load(client,actor.workspaceId,id,' FOR NO KEY UPDATE OF t')??notFound();
      const revision=nextRevision(current,expectedRevision);
      if(row.status!=='ATIVA')throw new ApiError(409,'TRANSACTION_INACTIVE','Movimentação excluída');
      const before={accountId:row.account_id,occurredOn:row.occurred_on,direction:row.direction,amountCents:row.amount_cents,description:row.description,
        category:row.category,classification:row.classification,isPfBusinessExpense:row.is_pf_business_expense,explanation:row.explanation};
      const after={...before,...changes};
      const changed=(Object.keys(after) as (keyof typeof after)[]).filter(key=>after[key]!==before[key]);
      if(!changed.length)return{transaction:record(row),revision:current};
      let accountType=row.account_type;
      if(after.accountId!==before.accountId&&row.source_type==='CSV')throw new ApiError(409,'IMPORTED_TRANSACTION_ACCOUNT_LOCKED','Conta de lançamento importado não pode ser trocada');
      if(after.accountId!==before.accountId){
        const account=(await client.query<{account_type:'PF'|'PJ';active:boolean}>('SELECT account_type,active FROM mimir.accounts WHERE workspace_id=$1 AND id=$2 FOR SHARE',
          [actor.workspaceId,after.accountId])).rows[0]??notFound();
        if(!account.active)throw new ApiError(409,'ACCOUNT_INACTIVE','Conta inativa');
        accountType=account.account_type;
      }
      mergedRulesValid(after);
      if(after.isPfBusinessExpense&&accountType!=='PF')throw new ApiError(422,'INVALID_PF_BUSINESS_EXPENSE','Marca empresarial exige despesa em conta PF');
      const material=changed.some(key=>(materialFields as readonly string[]).includes(key));
      if(material&&row.reimbursement_link_id)throw linkedConflict();
      const periodMonth=after.occurredOn.slice(0,7);
      await client.query(`INSERT INTO mimir.periods(id,workspace_id,period_month) VALUES($1,$2,$3) ON CONFLICT(workspace_id,period_month) DO NOTHING`,
        [randomUUID(),actor.workspaceId,periodMonth]);
      await client.query(`UPDATE mimir.transactions SET account_id=$3,occurred_on=$4::date,period_month=$5,direction=$6,amount_cents=$7,description=$8,category=$9,
        classification=$10,is_pf_business_expense=$11,explanation=$12,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
        [actor.workspaceId,id,after.accountId,after.occurredOn,periodMonth,after.direction,after.amountCents,after.description,after.category,
        after.classification,after.isPfBusinessExpense,after.explanation]);
      const hasActiveReimbursement=Boolean((await client.query(`SELECT 1 FROM mimir.reimbursement_links WHERE workspace_id=$1 AND pf_expense_id=$2 AND status='ATIVO'`,
        [actor.workspaceId,id])).rowCount);
      await reconcileTransactionPending(client,actor.workspaceId,id,{classification:after.classification,isPfBusinessExpense:after.isPfBusinessExpense,
        hasDocuments:row.document_ids.length>0,hasActiveReimbursement},material);
      await client.query('UPDATE mimir.workspaces SET revision=$1 WHERE id=$2',[revision,actor.workspaceId]);
      return{transaction:record((await this.load(client,actor.workspaceId,id))!),revision};
    });
  }

  remove(actor:WorkspaceActor,id:string,expectedRevision:number):Promise<TransactionMutation>{
    return this.write(actor,async(client,current)=>{
      const row=await this.load(client,actor.workspaceId,id,' FOR NO KEY UPDATE OF t')??notFound();
      const revision=nextRevision(current,expectedRevision);
      if(row.status!=='ATIVA')throw new ApiError(409,'TRANSACTION_ALREADY_DELETED','Movimentação já excluída');
      if(row.reimbursement_link_id)throw linkedConflict();
      await client.query(`UPDATE mimir.transactions SET status='EXCLUIDA',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[actor.workspaceId,id]);
      await client.query('UPDATE mimir.workspaces SET revision=$1 WHERE id=$2',[revision,actor.workspaceId]);
      return{transaction:{...record(row),status:'EXCLUIDA'},revision};
    });
  }

  get(actor:WorkspaceActor,id:string):Promise<TransactionRecord>{
    return this.read(actor,async client=>record(await this.load(client,actor.workspaceId,id)??notFound()));
  }

  list(actor:WorkspaceActor,month:string,page:TransactionPage):Promise<{items:TransactionRecord[];nextCursor:string|null;revision:number}>{
    return this.read(actor,async client=>{
      if(page.cursor&&!page.cursor.occurredOn.startsWith(`${month}-`))notFound();
      const revision=(await client.query<{revision:number}>('SELECT revision FROM mimir.workspaces WHERE id=$1',[actor.workspaceId])).rows[0]!.revision;
      const rows=(await client.query<RecordRow>(`${recordQuery} WHERE t.workspace_id=$1 AND t.period_month=$2
        AND ($3::date IS NULL OR (t.occurred_on,t.id)>($3::date,$4::uuid)) ORDER BY t.occurred_on,t.id LIMIT $5`,
        [actor.workspaceId,month,page.cursor?.occurredOn??null,page.cursor?.id??null,page.limit+1])).rows;
      const items=rows.slice(0,page.limit).map(record),last=items.at(-1);
      return{items,nextCursor:rows.length>page.limit&&last?`${last.occurredOn}_${last.transactionId}`:null,revision};
    });
  }

  async close(): Promise<void>{await this.pool.end();}
}
