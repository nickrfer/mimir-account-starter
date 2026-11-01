import { ApiError } from '../http/error.js';
export function civilDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('DATE inválida');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (value < '1900-01-01' || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('DATE inválida');
  return value;
}
export function nextRevision(current: number, expected: number): number {
  if (current !== expected) throw new ApiError(409, 'REVISION_CONFLICT', 'Revisão desatualizada');
  if (current >= Number.MAX_SAFE_INTEGER) throw new ApiError(409, 'REVISION_EXHAUSTED', 'Limite de revisão atingido');
  return current + 1;
}
