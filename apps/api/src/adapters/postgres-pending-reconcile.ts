import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { pendingDescriptions, reconcileAutomaticPending, type ExistingPending, type PendingFacts } from '../transactions/pending.js';

export async function reconcileTransactionPending(client: pg.PoolClient, workspaceId: string, transactionId: string, facts: PendingFacts,
  materialChange: boolean): Promise<void> {
  const existing = (await client.query<ExistingPending>('SELECT type,status,justification FROM mimir.pending_items WHERE workspace_id=$1 AND transaction_id=$2',
    [workspaceId, transactionId])).rows;
  for (const action of reconcileAutomaticPending(facts, existing, materialChange)) {
    if (action.action === 'INSERT') await client.query('INSERT INTO mimir.pending_items(id,workspace_id,transaction_id,type,description) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), workspaceId, transactionId, action.type, pendingDescriptions[action.type]]);
    else await client.query(`UPDATE mimir.pending_items SET status=$4,justification=CASE WHEN $4='PENDENTE' THEN '' ELSE justification END,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND transaction_id=$2 AND type=$3`, [workspaceId, transactionId, action.type, action.action === 'RESOLVE' ? 'RESOLVIDA' : 'PENDENTE']);
  }
}

export async function currentPendingFacts(client: pg.PoolClient, workspaceId: string, transactionId: string): Promise<PendingFacts> {
  const row = (await client.query<{ classification: PendingFacts['classification']; is_pf_business_expense: boolean; has_documents: boolean; has_reimbursement: boolean }>(
    `SELECT t.classification,t.is_pf_business_expense,
      EXISTS(SELECT 1 FROM mimir.transaction_documents d WHERE d.workspace_id=t.workspace_id AND d.transaction_id=t.id) AS has_documents,
      EXISTS(SELECT 1 FROM mimir.reimbursement_links r WHERE r.workspace_id=t.workspace_id AND r.pf_expense_id=t.id AND r.status='ATIVO') AS has_reimbursement
     FROM mimir.transactions t WHERE t.workspace_id=$1 AND t.id=$2`, [workspaceId, transactionId])).rows[0]!;
  return { classification: row.classification, isPfBusinessExpense: row.is_pf_business_expense, hasDocuments: row.has_documents, hasActiveReimbursement: row.has_reimbursement };
}
