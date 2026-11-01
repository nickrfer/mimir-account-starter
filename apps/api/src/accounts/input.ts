import { exactObject, text } from '../auth/input.js';
import { ApiError } from '../http/error.js';
import type { CreateAccount, AccountPage } from '../ports/accounts.js';
export { nextRevision } from '../domain/values.js';

export function accountInput(value: unknown): CreateAccount {
  const input = exactObject(value, ['name', 'accountType', 'expectedRevision']);
  const name = text(text(input.name, 1, 200).normalize('NFC').trim(), 1, 200);
  if (!name || typeof input.accountType !== 'string' || !['PF', 'PJ'].includes(input.accountType) ||
    !Number.isSafeInteger(input.expectedRevision) || typeof input.expectedRevision !== 'number' || input.expectedRevision < 1) {
    throw new ApiError(422, 'INVALID_INPUT', 'Dados inválidos');
  }
  return { name, nameKey: name.toLowerCase(), accountType: input.accountType as 'PF' | 'PJ', expectedRevision: input.expectedRevision };
}
export function accountPageInput(query: URLSearchParams): AccountPage {
  const invalid = () => new ApiError(400, 'INVALID_QUERY', 'Paginação inválida');
  for (const key of query.keys()) if (!['limit', 'cursor'].includes(key) || query.getAll(key).length !== 1) throw invalid();
  const value = query.get('limit') ?? '100';
  if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 200) throw invalid();
  const cursor = query.get('cursor');
  if (cursor !== null && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(cursor)) throw invalid();
  return { limit: Number(value), cursor: cursor?.toLowerCase() ?? null };
}
