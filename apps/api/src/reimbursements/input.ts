import { exactObject, text } from '../auth/input.js';
import { ApiError } from '../http/error.js';
import { previewMonth } from '../preview/http.js';
import type { CreateReimbursement, ReimbursementPage } from '../ports/reimbursements.js';

const invalid = () => new ApiError(422, 'INVALID_INPUT', 'Dados inválidos');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}

export function reimbursementInput(value: unknown): CreateReimbursement {
  const input = exactObject(value, ['pfExpenseTransactionId', 'pjReimbursementTransactionId', 'pfInflowTransactionId', 'notes', 'expectedRevision']);
  const pfExpenseTransactionId = uuid(input.pfExpenseTransactionId), pjReimbursementTransactionId = uuid(input.pjReimbursementTransactionId);
  const pfInflowTransactionId = input.pfInflowTransactionId === null ? null : uuid(input.pfInflowTransactionId);
  const ids = [pfExpenseTransactionId, pjReimbursementTransactionId, pfInflowTransactionId].filter(id => id !== null);
  if (new Set(ids).size !== ids.length) throw invalid();
  const notes = text(text(input.notes, 0, 2000).normalize('NFC').replace(/\r\n?/g, '\n').trim(), 0, 2000);
  return { pfExpenseTransactionId, pjReimbursementTransactionId, pfInflowTransactionId, notes, expectedRevision: revision(input.expectedRevision) };
}
export function revisionInput(value: unknown): number {
  return revision(exactObject(value, ['expectedRevision']).expectedRevision);
}
export function linkId(value: string): string {
  if (!UUID.test(value)) throw new ApiError(422, 'INVALID_ID', 'Identificador inválido');
  return value.toLowerCase();
}
export function listQuery(query: URLSearchParams): { month: string; page: ReimbursementPage } {
  const bad = () => new ApiError(400, 'INVALID_QUERY', 'Parâmetros inválidos');
  for (const key of query.keys()) if (!['periodMonth', 'limit', 'cursor'].includes(key) || query.getAll(key).length !== 1) throw bad();
  const month = query.get('periodMonth');
  if (month === null) throw bad();
  const limit = query.get('limit') ?? '100';
  if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 200) throw bad();
  const cursor = query.get('cursor');
  if (cursor !== null && !UUID.test(cursor)) throw bad();
  return { month: previewMonth(month), page: { limit: Number(limit), cursor: cursor?.toLowerCase() ?? null } };
}
export function candidatesQuery(query: URLSearchParams): string {
  if (query.size !== 1 || query.getAll('pfExpenseId').length !== 1) throw new ApiError(400, 'INVALID_QUERY', 'Parâmetros inválidos');
  return linkId(query.get('pfExpenseId')!);
}
