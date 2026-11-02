import type {WorkspaceActor} from './workspace.js';
export type DocumentMime='application/pdf'|'image/png'|'image/jpeg';
export interface UploadDocument {
  originalName:string;mime:DocumentMime;bytes:Buffer;sizeBytes:number;sha256:string;expectedRevision:number;
}
export interface DocumentMutation {documentId:string;transactionId:string;sha256:string;sizeBytes:number;revision:number;}
export interface DocumentSummary {
  documentId:string;originalName:string;mimeType:DocumentMime;sizeBytes:number;sha256:string;createdAt:string;
  supersedesDocumentId:string|null;transactionIds:string[];
}
export interface DocumentList {periodMonth:string;documents:DocumentSummary[];revision:number;}
export interface DocumentContent {documentId:string;mimeType:DocumentMime;bytes:Buffer;sha256:string;}
export interface DocumentLinkMutation {transactionId:string;documentId:string;revision:number;}
export interface DocumentReplacement extends DocumentMutation {replacedDocumentId:string;}
export interface DocumentsPort {
  upload(actor:WorkspaceActor,command:UploadDocument,transactionId:string):Promise<DocumentMutation>;
  listPeriod(actor:WorkspaceActor,periodMonth:string):Promise<DocumentList>;
  readContent(actor:WorkspaceActor,documentId:string):Promise<DocumentContent>;
  link(actor:WorkspaceActor,transactionId:string,documentId:string,expectedRevision:number):Promise<DocumentLinkMutation>;
  unlink(actor:WorkspaceActor,transactionId:string,documentId:string,expectedRevision:number):Promise<DocumentLinkMutation>;
  replace(actor:WorkspaceActor,transactionId:string,replacedDocumentId:string,command:UploadDocument):Promise<DocumentReplacement>;
  close():Promise<void>;
}
