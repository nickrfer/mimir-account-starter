import type {IncomingMessage,ServerResponse} from 'node:http';
import type {SessionHttpOptions} from '../auth/http.js';
import {sessionHash} from '../auth/service.js';
import {assertOrigin,cookieToken,jsonInput,runApiRequest} from '../http/common.js';
import {ApiError} from '../http/error.js';
import type {DocumentMime,DocumentsPort} from '../ports/documents.js';
import type {WorkspaceActor} from '../ports/workspace.js';
import {documentIdInput,documentListQuery,linkInput,revisionBodyInput,transactionIdInput} from './input.js';
import {multipartInput,replacementInput,reserveUpload} from './multipart.js';

export type DocumentTarget =
  | {kind:'upload';transactionId:string}
  | {kind:'list'}
  | {kind:'content';documentId:string}
  | {kind:'links';transactionId:string}
  | {kind:'link';transactionId:string;documentId:string}
  | {kind:'replacements';transactionId:string};

export function documentTarget(path:string):DocumentTarget|null{
  if(path==='/api/v1/documents')return{kind:'list'};
  let match=/^\/api\/v1\/documents\/([^/]+)\/content$/.exec(path);
  if(match)return{kind:'content',documentId:match[1]!};
  match=/^\/api\/v1\/transactions\/([^/]+)\/(documents|document-links|document-replacements)$/.exec(path);
  if(match)return match[2]==='documents'?{kind:'upload',transactionId:match[1]!}:match[2]==='document-links'?{kind:'links',transactionId:match[1]!}:{kind:'replacements',transactionId:match[1]!};
  match=/^\/api\/v1\/transactions\/([^/]+)\/document-links\/([^/]+)$/.exec(path);
  return match?{kind:'link',transactionId:match[1]!,documentId:match[2]!}:null;
}
const extension:Record<DocumentMime,string>={'application/pdf':'pdf','image/png':'png','image/jpeg':'jpg'};
const mutatingMethod:Record<DocumentTarget['kind'],string|null>={upload:'POST',list:null,content:null,links:'POST',link:'DELETE',replacements:'POST'};

export function handleDocuments(req:IncomingMessage,res:ServerResponse,options:SessionHttpOptions,documents:DocumentsPort,target:DocumentTarget):Promise<void>{
  const mutating=mutatingMethod[target.kind]===req.method;
  const operation=target.kind==='upload'?(req.method==='POST'?'documents.POST':'documents.unsupported'):`documents.${target.kind}.${req.method??'unknown'}`;
  return runApiRequest(req,res,operation,options,async()=>{
    const token=cookieToken(req),csrf=req.headers['x-csrf-token'];
    const context=mutating?await options.service.authorizeMutation(token,typeof csrf==='string'?csrf:undefined):await options.service.session(token);
    assertOrigin(req,options,mutating);
    const actor:WorkspaceActor={userId:context.userId,workspaceId:context.workspace.workspaceId,tokenHash:sessionHash(token!)};
    const query=new URL(req.url??'/','http://localhost').searchParams;
    if(target.kind==='list'&&req.method==='GET'){
      const result=await documents.listPeriod(actor,documentListQuery(query));
      res.writeHead(200);res.end(JSON.stringify(result));return;
    }
    if(target.kind==='content'&&req.method==='GET'){
      if(query.size)throw new ApiError(400,'INVALID_QUERY','Parâmetros não permitidos');
      const file=await documents.readContent(actor,documentIdInput(target.documentId));
      res.setHeader('Content-Type','application/octet-stream');
      res.setHeader('Content-Length',String(file.bytes.length));
      res.setHeader('Content-Disposition',`attachment; filename="documento-${file.documentId}.${extension[file.mimeType]}"`);
      res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
      res.setHeader('Cross-Origin-Resource-Policy','same-origin');
      res.setHeader('X-Content-SHA256',file.sha256);
      res.writeHead(200);res.end(file.bytes);return;
    }
    if(!mutating)throw new ApiError(405,'METHOD_NOT_ALLOWED','Método não permitido');
    if(query.size)throw new ApiError(400,'INVALID_QUERY','Parâmetros não permitidos');
    if(target.kind==='upload'){
      const transactionId=transactionIdInput(target.transactionId),release=reserveUpload();
      try{
        const result=await documents.upload(actor,await multipartInput(req),transactionId);
        res.writeHead(201);res.end(JSON.stringify(result));
      }finally{release();}
      return;
    }
    if(target.kind==='replacements'){
      const transactionId=documentIdInput(target.transactionId),release=reserveUpload();
      try{
        const {document,replacedDocumentId}=await replacementInput(req);
        const result=await documents.replace(actor,transactionId,replacedDocumentId,document);
        res.writeHead(201);res.end(JSON.stringify(result));
      }finally{release();}
      return;
    }
    if(target.kind==='links'){
      const transactionId=documentIdInput(target.transactionId),{documentId,expectedRevision}=linkInput(await jsonInput(req,8192));
      const result=await documents.link(actor,transactionId,documentId,expectedRevision);
      res.writeHead(201);res.end(JSON.stringify(result));return;
    }
    if(target.kind==='link'){
      const transactionId=documentIdInput(target.transactionId),documentId=documentIdInput(target.documentId);
      const result=await documents.unlink(actor,transactionId,documentId,revisionBodyInput(await jsonInput(req,8192)));
      res.writeHead(200);res.end(JSON.stringify(result));return;
    }
    throw new ApiError(405,'METHOD_NOT_ALLOWED','Método não permitido');
  });
}
