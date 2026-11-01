import type { CapturedPayload } from './deliveries.js';

export interface OperationClaim { operationId: string; workspaceId: string; snapshotId: string; token: number; attempt: number; holder: string }
export interface PublishedPackage { zip: Buffer; zipHash: string; manifest: Buffer; manifestHash: string }
export type FailureOutcome = 'RESCHEDULED' | 'FAILED' | 'LOST';

export interface ExecutorPort {
  claimNextOperation(holder: string): Promise<OperationClaim | null>;
  renewLease(claim: OperationClaim): Promise<boolean>;
  readSnapshot(claim: OperationClaim): Promise<CapturedPayload>;
  readCapturedDocument(claim: OperationClaim, documentId: string): Promise<Buffer>;
  publishPackage(claim: OperationClaim, published: PublishedPackage): Promise<boolean>;
  handleAttemptFailure(claim: OperationClaim, errorCode: string): Promise<FailureOutcome>;
  close(): Promise<void>;
}

export class LeaseLostError extends Error {
  constructor() { super('LEASE_LOST'); }
}
