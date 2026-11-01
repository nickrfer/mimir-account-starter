import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { postgresTypes } from './postgres.js';
import { authorizeActor,lockWorkspace } from './postgres-workspace.js';
import { nextRevision } from '../domain/values.js';
import { ApiError } from '../http/error.js';
import { validateAccount } from '../transactions/input.js';
import { initialPendingTypes,pendingDescriptions } from '../transactions/pending.js';
import type { WorkspaceActor } from '../ports/workspace.js';
import type { CreateTransaction,ManualTransaction,TransactionsPort } from '../ports/transactions.js';
export class PostgresTransactions implements TransactionsPort {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool=new pg.Pool({connectionString:databaseUrl,max:4,types:postgresTypes,application_name:'mimir-transactions',
      connectionTimeoutMillis:1500,query_timeout:1500,idleTimeoutMillis:10000,options:'-c statement_timeout=1500 -c search_path=mimir,pg_catalog'});
    this.pool.on('error',()=>{});
  }
  async create(actor: WorkspaceActor, command: CreateTransaction): Promise<{transaction:ManualTransaction;revision:number}> {
    const client=await this.pool.connect();let broken=false;
    try{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const current=await lockWorkspace(client,actor);
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
      // Account/period writes may wait after the workspace authorization check.
      await authorizeActor(client,actor);
      await client.query('UPDATE mimir.workspaces SET revision=$1 WHERE id=$2',[revision,actor.workspaceId]);
      const row=inserted.rows[0]!;
      const transaction: ManualTransaction={transactionId:row.id,accountId:account.id,accountName:account.name,accountType:account.account_type,
        occurredOn:row.occurred_on,direction:command.direction,amountCents:row.amount_cents,descriptionOriginal:command.description,
        categoryOriginal:command.category,classification:command.classification,isPfBusinessExpense:command.isPfBusinessExpense,
        explanationOriginal:command.explanation,sourceType:'MANUAL',sourceCode:'MANUAL',externalId:row.id,documentIds:[],
        reimbursementStatus:command.isPfBusinessExpense?'PENDENTE_REEMBOLSO':'NAO_APLICAVEL'};
      await client.query('COMMIT');return{transaction,revision};
    }catch(error){try{await client.query('ROLLBACK');}catch{broken=true;}throw error;}
    finally{client.release(broken);}
  }
  async close(): Promise<void>{await this.pool.end();}
}
