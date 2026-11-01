import type {IncomingMessage,ServerResponse} from 'node:http';
import type {SessionHttpOptions} from '../auth/http.js';
import {sessionHash} from '../auth/service.js';
import {assertOrigin,cookieToken,runApiRequest} from '../http/common.js';
import {ApiError} from '../http/error.js';
import type {DocumentsPort} from '../ports/documents.js';
import {transactionIdInput} from './input.js';
import {multipartInput,reserveUpload} from './multipart.js';
export function handleDocuments(req:IncomingMessage,res:ServerResponse,options:SessionHttpOptions,documents:DocumentsPort,id:string):Promise<void>{
  return runApiRequest(req,res,req.method==='POST'?'documents.POST':'documents.unsupported',options,async()=>{
    const token=cookieToken(req),csrf=req.headers['x-csrf-token'];
    const context=req.method==='POST'?await options.service.authorizeMutation(token,typeof csrf==='string'?csrf:undefined):await options.service.session(token);
    assertOrigin(req,options,req.method==='POST');
    if(req.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Método não permitido');
    if(new URL(req.url??'/','http://localhost').searchParams.size)throw new ApiError(400,'INVALID_QUERY','Parâmetros não permitidos');
    const transactionId=transactionIdInput(id),release=reserveUpload();
    try{
      const command=await multipartInput(req);
      const result=await documents.upload({userId:context.userId,workspaceId:context.workspace.workspaceId,tokenHash:sessionHash(token!)},command,transactionId);
      res.writeHead(201);res.end(JSON.stringify(result));
    }finally{release();}
  });
}
