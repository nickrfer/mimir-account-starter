import { createHash } from 'node:crypto';
import { exactObject, text } from '../auth/input.js';
import { ApiError } from '../http/error.js';
import { previewMonth } from '../preview/http.js';
import type { CaptureCommand } from '../ports/deliveries.js';

export function captureInput(value: unknown): CaptureCommand {
  const input = exactObject(value, ['periodMonth', 'expectedRevision', 'rectificationReason']);
  const periodMonth = previewMonth(text(input.periodMonth, 7, 7));
  if (typeof input.expectedRevision !== 'number' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new ApiError(422, 'INVALID_INPUT', 'Dados inválidos');
  const reason = text(input.rectificationReason, 0, 2000).normalize('NFC').replace(/\r\n?/g, '\n').trim();
  return { periodMonth, expectedRevision: input.expectedRevision, rectificationReason: text(reason, 0, 2000) };
}
export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new ApiError(422, 'INVALID_IDEMPOTENCY_KEY', 'Chave idempotente inválida');
  return value;
}
export function captureFingerprint(command: CaptureCommand): string {
  return createHash('sha256').update(JSON.stringify([1, command.periodMonth, command.expectedRevision, command.rectificationReason]), 'utf8').digest('hex');
}
export function operationId(value: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new ApiError(422, 'INVALID_ID', 'Identificador inválido');
  return value.toLowerCase();
}
