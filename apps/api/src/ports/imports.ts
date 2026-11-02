import type { ClassifiedRow, ImportTotals } from '../imports/classify.js';
import type { WorkspaceActor } from './workspace.js';

export interface ImportCommand { accountId: string; sourceCode: string; periodMonth: string; file: Buffer; fileHash: string }
export interface ConfirmCommand extends ImportCommand { expectedFileHash: string; expectedRevision: number }
export interface ImportPreview {
  fileHash: string; revision: number; accountId: string; sourceCode: string; periodMonth: string; sourceCodeKnown: boolean;
  totals: ImportTotals; rows: ClassifiedRow[];
}
export interface ImportConfirmation { batchId: string | null; fileHash: string; totals: ImportTotals; transactionIds: string[]; revision: number }
export interface ImportsPort {
  preview(actor: WorkspaceActor, command: ImportCommand): Promise<ImportPreview>;
  confirm(actor: WorkspaceActor, command: ConfirmCommand): Promise<{ created: boolean; result: ImportConfirmation }>;
  close(): Promise<void>;
}
