import type { IncomingMessage,ServerResponse } from 'node:http';
import type { SessionHttpOptions } from '../auth/http.js';
import { sessionHash } from '../auth/service.js';
import { assertOrigin,cookieToken,jsonInput,runApiRequest } from '../http/common.js';
import { ApiError } from '../http/error.js';
import { civilDate } from '../domain/values.js';
import { previewMonth } from '../preview/http.js';
import { operationId } from '../deliveries/input.js';
import { revisionInput } from '../reimbursements/input.js';
import type { TransactionPage,TransactionsPort } from '../ports/transactions.js';
import { transactionInput,transactionPatchInput } from './input.js';

function listQuery(query: URLSearchParams): {month:string;page:TransactionPage} {
  const bad=()=>new ApiError(400,'INVALID_QUERY','Parâmetros inválidos');
  for(const key of query.keys())if(!['periodMonth','limit','cursor'].includes(key)||query.getAll(key).length!==1)throw bad();
  const month=query.get('periodMonth');
  if(month===null)throw bad();
  const limit=query.get('limit')??'100';
  if(!/^[1-9][0-9]{0,2}$/.test(limit)||Number(limit)>200)throw bad();
  const raw=query.get('cursor');let cursor:TransactionPage['cursor']=null;
  if(raw!==null){
    const match=/^(\d{4}-\d{2}-\d{2})_([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(raw);
    if(!match)throw bad();
    try{cursor={occurredOn:civilDate(match[1]!),id:match[2]!.toLowerCase()};}catch{throw bad();}
  }
  return{month:previewMonth(month),page:{limit:Number(limit),cursor}};
}

export function handleTransactions(req: IncomingMessage,res: ServerResponse,options: SessionHttpOptions,transactions: TransactionsPort,id?: string): Promise<void> {
  const mutating=id===undefined?req.method==='POST':req.method==='PATCH'||req.method==='DELETE';
  return runApiRequest(req,res,`transactions.${id===undefined?'collection':'item'}.${req.method??'unknown'}`,options,async()=>{
    const token=cookieToken(req),csrf=req.headers['x-csrf-token'];
    const context=mutating?await options.service.authorizeMutation(token,typeof csrf==='string'?csrf:undefined):await options.service.session(token);
    assertOrigin(req,options,mutating);
    const actor={userId:context.userId,workspaceId:context.workspace.workspaceId,tokenHash:sessionHash(token!)};
    const query=new URL(req.url??'/','http://localhost').searchParams;
    if(id===undefined&&req.method==='GET'){
      const {month,page}=listQuery(query);const result=await transactions.list(actor,month,page);
      res.writeHead(200);res.end(JSON.stringify(result));return;
    }
    if(id===undefined&&req.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Método não permitido');
    if(query.size)throw new ApiError(400,'INVALID_QUERY','Parâmetros não permitidos');
    if(id===undefined){
      const result=await transactions.create(actor,transactionInput(await jsonInput(req,32768)));
      res.writeHead(201);res.end(JSON.stringify(result));return;
    }
    const transactionId=operationId(id);
    if(req.method==='GET'){const result=await transactions.get(actor,transactionId);res.writeHead(200);res.end(JSON.stringify(result));return;}
    if(req.method==='PATCH'){
      const {changes,expectedRevision}=transactionPatchInput(await jsonInput(req,32768));
      const result=await transactions.update(actor,transactionId,changes,expectedRevision);res.writeHead(200);res.end(JSON.stringify(result));return;
    }
    if(req.method==='DELETE'){
      const result=await transactions.remove(actor,transactionId,revisionInput(await jsonInput(req,1024)));res.writeHead(200);res.end(JSON.stringify(result));return;
    }
    throw new ApiError(405,'METHOD_NOT_ALLOWED','Método não permitido');
  });
}
