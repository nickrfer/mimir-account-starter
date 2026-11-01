import { ApiError as AuthError } from '../http/error.js';
export { AuthError };
const invalid = () => new AuthError(422, 'INVALID_INPUT', 'Dados inválidos');
export function exactObject(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw invalid();
  return value as Record<string, unknown>;
}
export function text(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || [...value].length < min || [...value].length > max || value.includes('\0')) throw invalid();
  return value;
}
export function normalizedEmail(value: unknown): string {
  const email = text(value, 1, 1024).normalize('NFC').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid();
  return email;
}
export function loginInput(value: unknown): { email: string; password: string } {
  const input = exactObject(value, ['email', 'password']);
  return { email: normalizedEmail(input.email), password: text(input.password, 1, 1024) };
}
