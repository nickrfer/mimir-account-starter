import type { PendingCommand, PendingStatus, PendingType } from '../ports/pending-items.js';

export interface PendingState { type: PendingType; status: PendingStatus; description: string; justification: string }
export type PendingDecision =
  | { kind: 'NOOP' }
  | { kind: 'CHANGE'; status: PendingStatus; justification: string; description: string }
  | { kind: 'CONFLICT'; code: 'PENDING_RESOLVED' | 'PENDING_AUTOMATIC' };

const conflict = (code: 'PENDING_RESOLVED' | 'PENDING_AUTOMATIC'): PendingDecision => ({ kind: 'CONFLICT', code });

export function decidePendingAction(current: PendingState, command: PendingCommand): PendingDecision {
  const manual = current.type === 'DUVIDA_CADASTRADA', { status, justification, description } = current;
  if (command.action === 'JUSTIFY') {
    if (status === 'RESOLVIDA') return conflict('PENDING_RESOLVED');
    if (status === 'JUSTIFICADA' && justification === command.justification) return { kind: 'NOOP' };
    return { kind: 'CHANGE', status: 'JUSTIFICADA', justification: command.justification, description };
  }
  if (!manual) return conflict('PENDING_AUTOMATIC');
  if (command.action === 'RESOLVE') {
    return status === 'RESOLVIDA' ? { kind: 'NOOP' } : { kind: 'CHANGE', status: 'RESOLVIDA', justification, description };
  }
  if (command.action === 'REOPEN') {
    return status === 'PENDENTE' ? { kind: 'NOOP' } : { kind: 'CHANGE', status: 'PENDENTE', justification: '', description };
  }
  if (status === 'RESOLVIDA') return conflict('PENDING_RESOLVED');
  if (description === command.description) return { kind: 'NOOP' };
  return { kind: 'CHANGE', status, justification, description: command.description };
}
