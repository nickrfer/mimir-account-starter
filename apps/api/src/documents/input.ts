import {createHash} from 'node:crypto';
import {text} from '../auth/input.js';
import {ApiError} from '../http/error.js';
import type {UploadDocument} from '../ports/documents.js';
export const MAX_DOCUMENT_BYTES=5242880;
const invalid=()=>new ApiError(422,'INVALID_INPUT','Documento ou campos inválidos');
export function revisionInput(value:unknown):number {
  if(typeof value!=='string'||!/^[1-9]\d{0,15}$/.test(value)||!Number.isSafeInteger(Number(value)))throw invalid();
  return Number(value);
}
export function transactionIdInput(value:string):string {
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))throw invalid();
  return value.toLowerCase();
}
export function documentInput(name:string,mime:string,bytes:Buffer,expectedRevision:number):UploadDocument {
  const originalName=text(text(name,1,255).normalize('NFC').trim(),1,255);
  if(/[\\/\p{Cc}]/u.test(originalName))throw invalid();
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw invalid();
  if(bytes.length>MAX_DOCUMENT_BYTES)throw new ApiError(413,'REQUEST_TOO_LARGE','Arquivo excede limite');
  if(bytes.length===0)throw invalid();
  const extension=/\.([a-z]+)$/i.exec(originalName)?.[1]?.toLowerCase();
  let allowed:UploadDocument['mime'],signature:Buffer;
  switch(extension){
    case 'pdf':allowed='application/pdf';signature=Buffer.from('%PDF-');break;
    case 'png':allowed='image/png';signature=Buffer.from('89504e470d0a1a0a','hex');break;
    case 'jpg':case 'jpeg':allowed='image/jpeg';signature=Buffer.from('ffd8ff','hex');break;
    default:throw new ApiError(415,'UNSUPPORTED_MEDIA_TYPE','Tipo de documento não permitido');
  }
  if(mime!==allowed)throw new ApiError(415,'UNSUPPORTED_MEDIA_TYPE','Extensão e MIME incompatíveis');
  if(!bytes.subarray(0,signature.length).equals(signature))throw invalid();
  return{originalName,mime:allowed,bytes,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),expectedRevision};
}
