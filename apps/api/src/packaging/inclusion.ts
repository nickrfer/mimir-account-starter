import type { CapturedPayload } from '../ports/deliveries.js';

export type InclusionReason = 'VINCULO_DIRETO_PERIODO' | 'CONTEXTO_REEMBOLSO';

export function documentInclusionReasons(payload: CapturedPayload): (documentId: string) => InclusionReason[] {
  const direct = new Set(payload.transactions.flatMap(t => t.documentIds));
  const context = new Set(payload.contextTransactions.flatMap(t => t.documentIds));
  return documentId => [
    ...(direct.has(documentId) ? ['VINCULO_DIRETO_PERIODO' as const] : []),
    ...(context.has(documentId) ? ['CONTEXTO_REEMBOLSO' as const] : []),
  ];
}
