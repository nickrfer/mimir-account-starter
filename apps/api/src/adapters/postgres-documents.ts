import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {postgresTypes} from './postgres.js';
import {authorizeActor,lockWorkspace} from './postgres-workspace.js';
import {nextRevision} from '../domain/values.js';
import {ApiError} from '../http/error.js';
import type {WorkspaceActor} from '../ports/workspace.js';
import type {DocumentMutation,DocumentsPort,UploadDocument} from '../ports/documents.js';
export class PostgresDocuments implements DocumentsPort {
  private readonly pool:pg.Pool;
  constructor(databaseUrl:string){
    this.pool=new pg.Pool({connectionString:databaseUrl,max:2,types:postgresTypes,application_name:'mimir-documents',
      connectionTimeoutMillis:1500,query_timeout:1500,idleTimeoutMillis:10000,options:'-c statement_timeout=1500 -c search_path=mimir,pg_catalog'});
    this.pool.on('error',()=>{});
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
  async close():Promise<void>{await this.pool.end();}
}
