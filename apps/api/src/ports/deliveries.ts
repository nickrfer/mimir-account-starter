import type { WorkspaceActor } from './workspace.js';
import type { Preview } from './preview.js';

export interface CaptureCommand { periodMonth: string; expectedRevision: number; rectificationReason: string }
export interface DeliveryOperation {
  id: string; snapshotId: string; periodMonth: string; versionNumber: number; capturedRevision: number;
  status: 'EM_FILA' | 'EM_PROCESSAMENTO' | 'PRONTA' | 'FALHA'; attemptCount: number; errorCode: string | null;
  createdAt: string; completedAt: string | null;
}
export interface CapturedDocument { documentId: string; originalName: string; mimeType: string; sizeBytes: number; sha256: string }
export interface PeriodSelection { preview: Preview; documents: CapturedDocument[]; period: { periodMonth: string; notes: string } }
export interface CapturedPayload extends Omit<Preview, 'revision' | 'periodMonth'> {
  schemaVersion: 'mimir.snapshot.v1'; documents: CapturedDocument[]; period: PeriodSelection['period'];
  delivery: { snapshotId: string; operationId: string; periodMonth: string; versionNumber: number; capturedRevision: number; rectificationReason: string; capturedAt: string };
}
export interface DeliveryPage { cursor: string | null; limit: number }
export interface PublishedFile { bytes: Buffer; sha256: string; periodMonth: string; versionNumber: number }
export interface DeliveriesPort {
  captureDelivery(actor: WorkspaceActor, command: CaptureCommand, key: string): Promise<{ operation: DeliveryOperation; status: 200 | 202 }>;
  getOperation(actor: WorkspaceActor, id: string): Promise<DeliveryOperation>;
  listDeliveries(actor: WorkspaceActor, month: string, page: DeliveryPage): Promise<{ items: DeliveryOperation[]; nextCursor: string | null }>;
  readPublishedFile(actor: WorkspaceActor, snapshotId: string, kind: 'package' | 'manifest'): Promise<PublishedFile>;
  close(): Promise<void>;
}
