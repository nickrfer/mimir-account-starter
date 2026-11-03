import { exactObject } from '../auth/input.js';
import { ApiError } from '../http/error.js';
import { previewMonth } from '../preview/http.js';
import { normalized } from '../transactions/input.js';
import { pendingTypes, type PendingCommand, type PendingPage, type PendingType } from '../ports/pending-items.js';

const invalid = () => new ApiError(422, 'INVALID_INPUT', 'Dados inválidos');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}

export function questionInput(value: unknown): { description: string; expectedRevision: number } {
  const input = exactObject(value, ['description', 'expectedRevision']);
  return { description: normalized(input.description, 3, 2000), expectedRevision: revision(input.expectedRevision) };
}

export function pendingActionInput(value: unknown): { command: PendingCommand; expectedRevision: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const action = (value as Record<string, unknown>).action;
  if (action === 'JUSTIFY') {
    const input = exactObject(value, ['action', 'justification', 'expectedRevision']);
    return { command: { action, justification: normalized(input.justification, 3, 2000) }, expectedRevision: revision(input.expectedRevision) };
  }
  if (action === 'EDIT') {
    const input = exactObject(value, ['action', 'description', 'expectedRevision']);
    return { command: { action, description: normalized(input.description, 3, 2000) }, expectedRevision: revision(input.expectedRevision) };
  }
  if (action === 'RESOLVE' || action === 'REOPEN') {
    const input = exactObject(value, ['action', 'expectedRevision']);
    return { command: { action }, expectedRevision: revision(input.expectedRevision) };
  }
  throw invalid();
}

export function pendingListQuery(query: URLSearchParams): { month: string; page: PendingPage } {
  const bad = () => new ApiError(400, 'INVALID_QUERY', 'Parâmetros inválidos');
  for (const key of query.keys()) if (!['periodMonth', 'limit', 'cursor'].includes(key) || query.getAll(key).length !== 1) throw bad();
  const month = query.get('periodMonth');
  if (month === null) throw bad();
  const limit = query.get('limit') ?? '100';
  if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 200) throw bad();
  const raw = query.get('cursor');
  let cursor: PendingPage['cursor'] = null;
  if (raw !== null) {
    const split = raw.lastIndexOf('_'), type = raw.slice(0, split), id = raw.slice(split + 1);
    if (split < 1 || !pendingTypes.includes(type as PendingType) || !UUID.test(id)) throw bad();
    cursor = { type: type as PendingType, id: id.toLowerCase() };
  }
  return { month: previewMonth(month), page: { limit: Number(limit), cursor } };
}
