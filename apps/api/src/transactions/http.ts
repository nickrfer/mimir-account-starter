import type { IncomingMessage,ServerResponse } from 'node:http';
import type { SessionHttpOptions } from '../auth/http.js';
import { sessionHash } from '../auth/service.js';
import { assertOrigin,cookieToken,jsonInput,runApiRequest } from '../http/common.js';
import { ApiError } from '../http/error.js';
import type { TransactionsPort } from '../ports/transactions.js';
import { transactionInput } from './input.js';
export function handleTransactions(req: IncomingMessage,res: ServerResponse,options: SessionHttpOptions,transactions: TransactionsPort): Promise<void> {
  return runApiRequest(req,res,req.method==='POST'?'transactions.POST':'transactions.unsupported',options,async()=>{
    const token=cookieToken(req),csrf=req.headers['x-csrf-token'];
    const context=req.method==='POST'?await options.service.authorizeMutation(token,typeof csrf==='string'?csrf:undefined):await options.service.session(token);
    assertOrigin(req,options,req.method==='POST');
    if(req.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Método não permitido');
    if(new URL(req.url??'/','http://localhost').searchParams.size)throw new ApiError(400,'INVALID_QUERY','Parâmetros não permitidos');
    const result=await transactions.create({userId:context.userId,workspaceId:context.workspace.workspaceId,tokenHash:sessionHash(token!)},transactionInput(await jsonInput(req,32768)));
    res.writeHead(201);res.end(JSON.stringify(result));
  });
}
