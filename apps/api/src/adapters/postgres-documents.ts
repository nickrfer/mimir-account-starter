import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {postgresTypes} from './postgres.js';
import {currentPendingFacts,reconcileTransactionPending} from './postgres-pending-reconcile.js';
import {authorizeActor,lockWorkspace} from './postgres-workspace.js';
import {nextRevision} from '../domain/values.js';
import {ApiError} from '../http/error.js';
import type {WorkspaceActor} from '../ports/workspace.js';
import type {DocumentContent,DocumentLinkMutation,DocumentList,DocumentMime,DocumentMutation,DocumentReplacement,DocumentsPort,UploadDocument} from '../ports/documents.js';

const LIST_LIMIT=1000;
const notFound=():never=>{throw new ApiError(404,'NOT_FOUND','Objeto não encontrado');};
const inactive=()=>new ApiError(409,'TRANSACTION_INACTIVE','Movimentação excluída');
interface SummaryRow {id:string;original_name:string;mime:DocumentMime;size_bytes:number;hash:string;created_at:Date;supersedes_document_id:string|null;transaction_ids:string[]}

export class PostgresDocuments implements DocumentsPort {
  private readonly pool:pg.Pool;
  private readonly bulk:pg.Pool;
  constructor(databaseUrl:string){
    this.pool=new pg.Pool({connectionString:databaseUrl,max:4,types:postgresTypes,application_name:'mimir-documents',
      connectionTimeoutMillis:1500,query_timeout:1500,idleTimeoutMillis:10000,options:'-c statement_timeout=1500 -c search_path=mimir,pg_catalog'});
    this.pool.on('error',()=>{});
    this.bulk=new pg.Pool({connectionString:databaseUrl,max:2,types:postgresTypes,application_name:'mimir-document-downloads',
      connectionTimeoutMillis:1500,query_timeout:10000,idleTimeoutMillis:10000,options:'-c statement_timeout=10000 -c search_path=mimir,pg_catalog'});
    this.bulk.on('error',()=>{});
  }
  private async write<T>(actor:WorkspaceActor,work:(client:pg.PoolClient,current:number)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect();let broken=false;
    try{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result=await work(client,await lockWorkspace(client,actor));
      await authorizeActor(client,actor);
      await client.query('COMMIT');return result;
    }catch(error){try{await client.query('ROLLBACK');}catch{broken=true;}throw error;}
    finally{client.release(broken);}
  }
  private async read<T>(actor:WorkspaceActor,work:(client:pg.PoolClient)=>Promise<T>,pool=this.pool):Promise<T>{
    const client=await pool.connect();let broken=false;
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await authorizeActor(client,actor);
      const result=await work(client);
      await authorizeActor(client,actor);
      await client.query('COMMIT');return result;
    }catch(error){try{await client.query('ROLLBACK');}catch{broken=true;}throw error;}
    finally{client.release(broken);}
  }
  private async transactionStatus(client:pg.PoolClient,workspaceId:string,transactionId:string):Promise<'ATIVA'|'EXCLUIDA'>{
    return((await client.query<{status:'ATIVA'|'EXCLUIDA'}>('SELECT status FROM mimir.transactions WHERE workspace_id=$1 AND id=$2 FOR SHARE',
      [workspaceId,transactionId])).rows[0]??notFound()).status;
  }
  private async linked(client:pg.PoolClient,workspaceId:string,transactionId:string,documentId:string):Promise<boolean>{
    return Boolean((await client.query('SELECT 1 FROM mimir.transaction_documents WHERE workspace_id=$1 AND transaction_id=$2 AND document_id=$3',
      [workspaceId,transactionId,documentId])).rowCount);
  }
  private async finish(client:pg.PoolClient,workspaceId:string,transactionId:string,revision:number):Promise<void>{
    await reconcileTransactionPending(client,workspaceId,transactionId,await currentPendingFacts(client,workspaceId,transactionId),true);
    await client.query('UPDATE mimir.workspaces SET revision=$1 WHERE id=$2',[revision,workspaceId]);
  }

  async upload(actor:WorkspaceActor,command:UploadDocument,transactionId:string):Promise<DocumentMutation>{
    const client=await this.pool.connect();let broken=false;
    try{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const current=await lockWorkspace(client,actor);
      const result=await client.query<{status:string}>('SELECT status FROM mimir.transactions WHERE workspace_id=$1 AND id=$2 FOR SHARE',[actor.workspaceId,transactionId]);
      if(!result.rows[0])throw new ApiError(404,'NOT_FOUND','Objeto não encontrado');
      if(result.rows[0].status!=='ATIVA')throw new ApiError(409,'TRANSACTION_INACTIVE','Movimentação excluída');
      const revision=nextRevision(current,command.expectedRevision),documentId=randomUUID();
      await client.query(`INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[documentId,actor.workspaceId,command.originalName,command.mime,command.sizeBytes,command.sha256,command.bytes]);
      await client.query('INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id) VALUES($1,$2,$3)',[actor.workspaceId,transactionId,documentId]);
      // A new documentary link eliminates the documentary cause and is material to other automatic justifications.
      await client.query(`UPDATE mimir.pending_items SET status='RESOLVIDA',updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND transaction_id=$2 AND type='DOCUMENTO_AUSENTE' AND status<>'RESOLVIDA'`,[actor.workspaceId,transactionId]);
      await client.query(`UPDATE mimir.pending_items SET status='PENDENTE',justification='',updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND transaction_id=$2 AND type IN ('CLASSIFICACAO_A_ESCLARECER','REEMBOLSO_PF_PENDENTE') AND status='JUSTIFICADA'`,[actor.workspaceId,transactionId]);
      await authorizeActor(client,actor);
      await client.query('UPDATE mimir.workspaces SET revision=$1 WHERE id=$2',[revision,actor.workspaceId]);
      await client.query('COMMIT');return{documentId,transactionId,sha256:command.sha256,sizeBytes:command.sizeBytes,revision};
    }catch(error){try{await client.query('ROLLBACK');}catch{broken=true;}throw error;}
    finally{client.release(broken);}
  }

  listPeriod(actor:WorkspaceActor,periodMonth:string):Promise<DocumentList>{
    return this.read(actor,async client=>{
      const revision=(await client.query<{revision:number}>('SELECT revision FROM mimir.workspaces WHERE id=$1',[actor.workspaceId])).rows[0]!.revision;
      const rows=(await client.query<SummaryRow>(`SELECT d.id,d.original_name,d.mime,d.size_bytes,d.hash,d.created_at,d.supersedes_document_id,
          array_agg(t.id::text ORDER BY t.id) AS transaction_ids
        FROM mimir.transaction_documents l
        JOIN mimir.transactions t ON (t.workspace_id,t.id)=(l.workspace_id,l.transaction_id)
        JOIN mimir.documents d ON (d.workspace_id,d.id)=(l.workspace_id,l.document_id)
        WHERE l.workspace_id=$1 AND t.period_month=$2 AND t.status='ATIVA'
        GROUP BY d.id,d.original_name,d.mime,d.size_bytes,d.hash,d.created_at,d.supersedes_document_id
        ORDER BY d.created_at,d.id LIMIT $3`,[actor.workspaceId,periodMonth,LIST_LIMIT+1])).rows;
      if(rows.length>LIST_LIMIT)throw new ApiError(413,'DOCUMENT_LIST_LIMIT_EXCEEDED','Mês excede o limite de documentos listados');
      return{periodMonth,revision,documents:rows.map(row=>({documentId:row.id,originalName:row.original_name,mimeType:row.mime,sizeBytes:row.size_bytes,
        sha256:row.hash,createdAt:row.created_at.toISOString(),supersedesDocumentId:row.supersedes_document_id,transactionIds:row.transaction_ids}))};
    });
  }

  readContent(actor:WorkspaceActor,documentId:string):Promise<DocumentContent>{
    return this.read(actor,async client=>{
      const row=(await client.query<{mime:DocumentMime;bytes:Buffer;hash:string}>('SELECT mime,bytes,hash FROM mimir.documents WHERE workspace_id=$1 AND id=$2',
        [actor.workspaceId,documentId])).rows[0]??notFound();
      return{documentId,mimeType:row.mime,bytes:row.bytes,sha256:row.hash};
    },this.bulk);
  }

  link(actor:WorkspaceActor,transactionId:string,documentId:string,expectedRevision:number):Promise<DocumentLinkMutation>{
    return this.write(actor,async(client,current)=>{
      const status=await this.transactionStatus(client,actor.workspaceId,transactionId);
      const document=await client.query('SELECT 1 FROM mimir.documents WHERE workspace_id=$1 AND id=$2',[actor.workspaceId,documentId]);
      if(!document.rowCount)notFound();
      const revision=nextRevision(current,expectedRevision);
      if(status!=='ATIVA')throw inactive();
      if(await this.linked(client,actor.workspaceId,transactionId,documentId))throw new ApiError(409,'DOCUMENT_ALREADY_LINKED','Documento já vinculado a esta movimentação');
      await client.query('INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id) VALUES($1,$2,$3)',[actor.workspaceId,transactionId,documentId]);
      await this.finish(client,actor.workspaceId,transactionId,revision);
      return{transactionId,documentId,revision};
    });
  }

  unlink(actor:WorkspaceActor,transactionId:string,documentId:string,expectedRevision:number):Promise<DocumentLinkMutation>{
    return this.write(actor,async(client,current)=>{
      const status=await this.transactionStatus(client,actor.workspaceId,transactionId);
      if(!await this.linked(client,actor.workspaceId,transactionId,documentId))notFound();
      const revision=nextRevision(current,expectedRevision);
      if(status!=='ATIVA')throw inactive();
      await client.query('DELETE FROM mimir.transaction_documents WHERE workspace_id=$1 AND transaction_id=$2 AND document_id=$3',[actor.workspaceId,transactionId,documentId]);
      await this.finish(client,actor.workspaceId,transactionId,revision);
      return{transactionId,documentId,revision};
    });
  }

  replace(actor:WorkspaceActor,transactionId:string,replacedDocumentId:string,command:UploadDocument):Promise<DocumentReplacement>{
    return this.write(actor,async(client,current)=>{
      const status=await this.transactionStatus(client,actor.workspaceId,transactionId);
      const replaced=await client.query('SELECT 1 FROM mimir.documents WHERE workspace_id=$1 AND id=$2',[actor.workspaceId,replacedDocumentId]);
      if(!replaced.rowCount)notFound();
      const revision=nextRevision(current,command.expectedRevision);
      if(status!=='ATIVA')throw inactive();
      if(!await this.linked(client,actor.workspaceId,transactionId,replacedDocumentId))throw new ApiError(409,'DOCUMENT_NOT_LINKED','Documento não está vinculado a esta movimentação');
      const documentId=randomUUID();
      await client.query(`INSERT INTO mimir.documents(id,workspace_id,original_name,mime,size_bytes,hash,bytes,supersedes_document_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[documentId,actor.workspaceId,command.originalName,command.mime,command.sizeBytes,command.sha256,command.bytes,replacedDocumentId]);
      await client.query('DELETE FROM mimir.transaction_documents WHERE workspace_id=$1 AND transaction_id=$2 AND document_id=$3',[actor.workspaceId,transactionId,replacedDocumentId]);
      await client.query('INSERT INTO mimir.transaction_documents(workspace_id,transaction_id,document_id) VALUES($1,$2,$3)',[actor.workspaceId,transactionId,documentId]);
      await this.finish(client,actor.workspaceId,transactionId,revision);
      return{documentId,replacedDocumentId,transactionId,sha256:command.sha256,sizeBytes:command.sizeBytes,revision};
    });
  }

  async close():Promise<void>{await Promise.all([this.pool.end(),this.bulk.end()]);}
}
