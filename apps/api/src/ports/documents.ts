import type {WorkspaceActor} from './workspace.js';
export interface UploadDocument {
  originalName:string;mime:'application/pdf'|'image/png'|'image/jpeg';bytes:Buffer;sizeBytes:number;sha256:string;expectedRevision:number;
}
export interface DocumentMutation {documentId:string;transactionId:string;sha256:string;sizeBytes:number;revision:number;}
export interface DocumentsPort {
  upload(actor:WorkspaceActor,command:UploadDocument,transactionId:string):Promise<DocumentMutation>;
  close():Promise<void>;
}
