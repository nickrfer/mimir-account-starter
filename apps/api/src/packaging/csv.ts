import type { CapturedDocument, CapturedPayload } from '../ports/deliveries.js';

const EXTENSIONS: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

export function attachmentPath(document: CapturedDocument): string {
  const extension = EXTENSIONS[document.mimeType];
  if (!extension) throw new Error('Unsupported attachment type');
  return `anexos/${document.documentId}.${extension}`;
}

const guarded = (value: string) => (/^ *[=+\-@\t\r\n]/.test(value) ? `'${value}` : value);
const field = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

const HEADER = ['transaction_id', 'account_id', 'account_name', 'account_type', 'occurred_on', 'direction', 'amount_cents',
  'description', 'category', 'classification', 'is_pf_business_expense', 'explanation', 'document_ids'];

export function renderCsv(payload: CapturedPayload): Buffer {
  const rows = payload.transactions.map(t => [t.transactionId, t.accountId, guarded(t.accountName), t.accountType, t.occurredOn,
    t.direction, String(t.amountCents), guarded(t.descriptionOriginal), guarded(t.categoryOriginal), t.classification,
    String(t.isPfBusinessExpense), guarded(t.explanationOriginal), t.documentIds.join(';')]);
  return Buffer.from([HEADER, ...rows].map(row => row.map(field).join(',')).join('\r\n') + '\r\n', 'utf8');
}
