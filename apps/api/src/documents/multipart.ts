import type {IncomingMessage} from 'node:http';
import {File} from 'node:buffer';
import {ApiError} from '../http/error.js';
import {documentInput,MAX_DOCUMENT_BYTES,revisionInput} from './input.js';
import type {UploadDocument} from '../ports/documents.js';
const MAX_BODY_BYTES=MAX_DOCUMENT_BYTES+16384;
let active=0;
// Reservation includes persistence: buffered files must not queue unboundedly in the pg pool.
export function reserveUpload():()=>void {
  if(active>=2)throw new ApiError(429,'UPLOAD_LIMIT','Uploads simultâneos excedidos',1);
  active++;let released=false;
  return()=>{if(!released){active--;released=true;}};
}
export async function multipartInput(req:IncomingMessage):Promise<UploadDocument> {
  const type=req.headers['content-type']??'';
  if(!/^multipart\/form-data(?:;|$)/i.test(type))throw new ApiError(415,'UNSUPPORTED_MEDIA_TYPE','Exigido multipart/form-data');
  if(Number(req.headers['content-length']??0)>MAX_BODY_BYTES)throw new ApiError(413,'REQUEST_TOO_LARGE','Corpo excede limite');
  const bytes=await new Promise<Buffer>((resolve,reject)=>{
    const chunks:Buffer[]=[];let size=0,exceeded=false;
    req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_BODY_BYTES){exceeded=true;chunks.length=0;reject(new ApiError(413,'REQUEST_TOO_LARGE','Corpo excede limite'));}else if(!exceeded)chunks.push(chunk);});
    req.once('end',()=>{if(!exceeded)resolve(Buffer.concat(chunks));});
    req.once('error',()=>reject(new ApiError(400,'INVALID_BODY','Corpo inválido')));
    req.once('aborted',()=>reject(new ApiError(400,'INVALID_BODY','Corpo interrompido')));
  });
  let form:FormData;
  try{form=await new Response(new Uint8Array(bytes),{headers:{'Content-Type':type}}).formData();}
  catch{throw new ApiError(400,'INVALID_BODY','Multipart inválido');}
  const entries=[...form.entries()];
  if(entries.length!==2||form.getAll('file').length!==1||form.getAll('expectedRevision').length!==1)throw new ApiError(422,'INVALID_INPUT','Campos inválidos');
  const file=form.get('file'),revision=revisionInput(form.get('expectedRevision'));
  if(!(file instanceof File))throw new ApiError(422,'INVALID_INPUT','Arquivo obrigatório');
  return documentInput(file.name,file.type,Buffer.from(await file.arrayBuffer()),revision);
}
