import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { postgresTypes } from './postgres.js';
import { authorizeActor, lockWorkspace } from './postgres-workspace.js';
import { nextRevision } from '../domain/values.js';
import { reimbursementViolation, type ParticipantFacts } from '../domain/reimbursements.js';
import { pendingDescriptions } from '../transactions/pending.js';
import { ApiError } from '../http/error.js';
import type { WorkspaceActor } from '../ports/workspace.js';
import type { CandidateTransaction, CreateReimbursement, ReimbursementCandidates, ReimbursementMutation, ReimbursementPage,
  ReimbursementRecord, ReimbursementsPort } from '../ports/reimbursements.js';

interface ParticipantRow {
  id: string; account_id: string; account_type: 'PF' | 'PJ'; occurred_on: string; direction: ParticipantFacts['direction'];
  classification: ParticipantFacts['classification']; amount_cents: number; is_pf_business_expense: boolean; status: 'ATIVA' | 'EXCLUIDA';
}
interface LinkRow {
  id: string; pf_expense_id: string; pj_outflow_id: string; pf_inflow_id: string | null; amount_cents: number; notes: string;
  status: 'ATIVO' | 'DESFEITO'; created_at: Date; undone_at: Date | null;
}
interface CandidateRow { id: string; account_id: string; name: string; occurred_on: string; amount_cents: number; description: string; category: string }

const linkColumns = 'id,pf_expense_id,pj_outflow_id,pf_inflow_id,amount_cents,notes,status,created_at,undone_at';
const participantQuery = `SELECT t.id,t.account_id,a.account_type,t.occurred_on,t.direction,t.classification,t.amount_cents,t.is_pf_business_expense,t.status
  FROM mimir.transactions t JOIN mimir.accounts a ON (a.workspace_id,a.id)=(t.workspace_id,t.account_id)
  WHERE t.workspace_id=$1 AND t.id=ANY($2::uuid[])`;
const candidateColumns = 't.id,t.account_id,a.name,t.occurred_on,t.amount_cents,t.description,t.category';

function record(row: LinkRow): ReimbursementRecord {
  return { reimbursementLinkId: row.id, pfExpenseTransactionId: row.pf_expense_id, pjReimbursementTransactionId: row.pj_outflow_id,
    pfInflowTransactionId: row.pf_inflow_id, amountCents: row.amount_cents, notes: row.notes, status: row.status,
    createdAt: row.created_at.toISOString(), undoneAt: row.undone_at?.toISOString() ?? null };
}
function facts(row: ParticipantRow): ParticipantFacts {
  return { transactionId: row.id, accountId: row.account_id, accountType: row.account_type, occurredOn: row.occurred_on, direction: row.direction,
    classification: row.classification, amountCents: row.amount_cents, isPfBusinessExpense: row.is_pf_business_expense };
}
function candidate(row: CandidateRow): CandidateTransaction {
  return { transactionId: row.id, accountId: row.account_id, accountName: row.name, occurredOn: row.occurred_on, amountCents: row.amount_cents,
    descriptionOriginal: row.description, categoryOriginal: row.category };
}
const notFound = (): never => { throw new ApiError(404, 'NOT_FOUND', 'Objeto não encontrado'); };
const alreadyLinked = () => new ApiError(409, 'REIMBURSEMENT_PARTICIPANT_LINKED', 'Movimentação já participa de um reembolso ativo');
const inactive = () => new ApiError(409, 'TRANSACTION_INACTIVE', 'Movimentação excluída');

// A link or its undo is a material change: justified automatic pending items of every participant reopen for review.
async function reopenJustified(client: pg.PoolClient, workspaceId: string, ids: string[]): Promise<void> {
  await client.query(`UPDATE mimir.pending_items SET status='PENDENTE',justification='',updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND transaction_id=ANY($2::uuid[]) AND type IN ('DOCUMENTO_AUSENTE','CLASSIFICACAO_A_ESCLARECER') AND status='JUSTIFICADA'`, [workspaceId, ids]);
}

export class PostgresReimbursements implements ReimbursementsPort {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4, types: postgresTypes, application_name: 'mimir-reimbursements',
      connectionTimeoutMillis: 1500, query_timeout: 1500, idleTimeoutMillis: 10000, options: '-c statement_timeout=1500 -c search_path=mimir,pg_catalog' });
    this.pool.on('error', () => {});
  }

  private async write<T>(actor: WorkspaceActor, work: (client: pg.PoolClient, current: number) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(client, await lockWorkspace(client, actor));
      await authorizeActor(client, actor);
      await client.query('COMMIT'); return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      if ((error as { code?: string }).code === '23505') throw alreadyLinked();
      throw error;
    } finally { client.release(broken); }
  }

  private async read<T>(actor: WorkspaceActor, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await authorizeActor(client, actor);
      const result = await work(client);
      await authorizeActor(client, actor);
      await client.query('COMMIT'); return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }

  create(actor: WorkspaceActor, command: CreateReimbursement): Promise<ReimbursementMutation> {
    return this.write(actor, async (client, current) => {
      const ids = [command.pfExpenseTransactionId, command.pjReimbursementTransactionId, ...(command.pfInflowTransactionId ? [command.pfInflowTransactionId] : [])];
      const rows = (await client.query<ParticipantRow>(`${participantQuery} FOR SHARE OF t`, [actor.workspaceId, ids])).rows;
      const byId = new Map(rows.map(row => [row.id, row]));
      const expense = byId.get(command.pfExpenseTransactionId) ?? notFound(), outflow = byId.get(command.pjReimbursementTransactionId) ?? notFound();
      const inflow = command.pfInflowTransactionId ? byId.get(command.pfInflowTransactionId) ?? notFound() : null;
      const revision = nextRevision(current, command.expectedRevision);
      if (rows.some(row => row.status !== 'ATIVA')) throw inactive();
      const violation = reimbursementViolation(facts(expense), facts(outflow), inflow ? facts(inflow) : null);
      if (violation) throw new ApiError(422, violation, 'Vínculo de reembolso inválido');
      const linked = await client.query(`SELECT 1 FROM mimir.reimbursement_links WHERE workspace_id=$1 AND status='ATIVO'
        AND (pf_expense_id=ANY($2::uuid[]) OR pj_outflow_id=ANY($2::uuid[]) OR pf_inflow_id=ANY($2::uuid[])) LIMIT 1`, [actor.workspaceId, ids]);
      if (linked.rowCount) throw alreadyLinked();
      const inserted = (await client.query<LinkRow>(`INSERT INTO mimir.reimbursement_links(id,workspace_id,pf_expense_id,pj_outflow_id,pf_inflow_id,amount_cents,notes)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${linkColumns}`, [randomUUID(), actor.workspaceId, expense.id, outflow.id, inflow?.id ?? null, expense.amount_cents, command.notes])).rows[0]!;
      await client.query(`UPDATE mimir.pending_items SET status='RESOLVIDA',updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND transaction_id=$2 AND type='REEMBOLSO_PF_PENDENTE' AND status<>'RESOLVIDA'`, [actor.workspaceId, expense.id]);
      await reopenJustified(client, actor.workspaceId, ids);
      await client.query('UPDATE mimir.workspaces SET revision=$1 WHERE id=$2', [revision, actor.workspaceId]);
      return { reimbursement: record(inserted), revision };
    });
  }

  undo(actor: WorkspaceActor, id: string, expectedRevision: number): Promise<ReimbursementMutation> {
    return this.write(actor, async (client, current) => {
      const row = (await client.query<LinkRow>(`SELECT ${linkColumns} FROM mimir.reimbursement_links WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [actor.workspaceId, id])).rows[0] ?? notFound();
      const revision = nextRevision(current, expectedRevision);
      if (row.status !== 'ATIVO') throw new ApiError(409, 'REIMBURSEMENT_ALREADY_UNDONE', 'Vínculo já desfeito');
      const undone = (await client.query<LinkRow>(`UPDATE mimir.reimbursement_links SET status='DESFEITO',undone_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2 RETURNING ${linkColumns}`, [actor.workspaceId, id])).rows[0]!;
      const reopened = await client.query(`UPDATE mimir.pending_items SET status='PENDENTE',justification='',updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND transaction_id=$2 AND type='REEMBOLSO_PF_PENDENTE'`, [actor.workspaceId, row.pf_expense_id]);
      if (!reopened.rowCount) await client.query(`INSERT INTO mimir.pending_items(id,workspace_id,transaction_id,type,description)
        VALUES($1,$2,$3,'REEMBOLSO_PF_PENDENTE',$4)`, [randomUUID(), actor.workspaceId, row.pf_expense_id, pendingDescriptions.REEMBOLSO_PF_PENDENTE]);
      await reopenJustified(client, actor.workspaceId, [row.pf_expense_id, row.pj_outflow_id, ...(row.pf_inflow_id ? [row.pf_inflow_id] : [])]);
      await client.query('UPDATE mimir.workspaces SET revision=$1 WHERE id=$2', [revision, actor.workspaceId]);
      return { reimbursement: record(undone), revision };
    });
  }

  list(actor: WorkspaceActor, month: string, page: ReimbursementPage): Promise<{ items: ReimbursementRecord[]; nextCursor: string | null }> {
    return this.read(actor, async client => {
      if (page.cursor && !(await client.query('SELECT 1 FROM mimir.reimbursement_links WHERE workspace_id=$1 AND id=$2', [actor.workspaceId, page.cursor])).rowCount) notFound();
      const rows = (await client.query<LinkRow>(`SELECT ${linkColumns} FROM mimir.reimbursement_links l
        WHERE l.workspace_id=$1 AND ($3::uuid IS NULL OR l.id>$3::uuid) AND EXISTS (SELECT 1 FROM mimir.transactions t
          WHERE t.workspace_id=l.workspace_id AND t.id IN (l.pf_expense_id,l.pj_outflow_id,l.pf_inflow_id) AND t.period_month=$2)
        ORDER BY l.id LIMIT $4`, [actor.workspaceId, month, page.cursor, page.limit + 1])).rows;
      const items = rows.slice(0, page.limit).map(record);
      return { items, nextCursor: rows.length > page.limit ? items.at(-1)!.reimbursementLinkId : null };
    });
  }

  candidates(actor: WorkspaceActor, pfExpenseId: string): Promise<ReimbursementCandidates> {
    return this.read(actor, async client => {
      const expense = (await client.query<ParticipantRow & { name: string; description: string; category: string }>(`SELECT t.id,t.account_id,a.account_type,a.name,
        t.occurred_on,t.direction,t.classification,t.amount_cents,t.is_pf_business_expense,t.status,t.description,t.category
        FROM mimir.transactions t JOIN mimir.accounts a ON (a.workspace_id,a.id)=(t.workspace_id,t.account_id)
        WHERE t.workspace_id=$1 AND t.id=$2`, [actor.workspaceId, pfExpenseId])).rows[0] ?? notFound();
      if (expense.status !== 'ATIVA') throw inactive();
      if (expense.account_type !== 'PF' || expense.direction !== 'SAIDA' || expense.classification !== 'DESPESA' || !expense.is_pf_business_expense)
        throw new ApiError(422, 'REIMBURSEMENT_INVALID_PF_EXPENSE', 'Vínculo de reembolso inválido');
      if ((await client.query(`SELECT 1 FROM mimir.reimbursement_links WHERE workspace_id=$1 AND pf_expense_id=$2 AND status='ATIVO'`, [actor.workspaceId, expense.id])).rowCount) throw alreadyLinked();
      const params = [actor.workspaceId, expense.amount_cents, expense.occurred_on];
      const pjOutflows = (await client.query<CandidateRow>(`SELECT ${candidateColumns} FROM mimir.transactions t
        JOIN mimir.accounts a ON (a.workspace_id,a.id)=(t.workspace_id,t.account_id)
        WHERE t.workspace_id=$1 AND a.account_type='PJ' AND t.direction='SAIDA' AND t.classification='TRANSFERENCIA' AND NOT t.is_pf_business_expense
          AND t.status='ATIVA' AND t.amount_cents=$2 AND t.occurred_on>=$3::date
          AND NOT EXISTS (SELECT 1 FROM mimir.reimbursement_links l WHERE l.workspace_id=t.workspace_id AND l.pj_outflow_id=t.id AND l.status='ATIVO')
        ORDER BY t.occurred_on,t.id LIMIT 200`, params)).rows;
      const pfInflows = (await client.query<CandidateRow>(`SELECT ${candidateColumns} FROM mimir.transactions t
        JOIN mimir.accounts a ON (a.workspace_id,a.id)=(t.workspace_id,t.account_id)
        WHERE t.workspace_id=$1 AND t.account_id=$4 AND t.direction='ENTRADA' AND t.classification='TRANSFERENCIA' AND NOT t.is_pf_business_expense
          AND t.status='ATIVA' AND t.amount_cents=$2 AND t.occurred_on>=$3::date
          AND NOT EXISTS (SELECT 1 FROM mimir.reimbursement_links l WHERE l.workspace_id=t.workspace_id AND l.pf_inflow_id=t.id AND l.status='ATIVO')
        ORDER BY t.occurred_on,t.id LIMIT 200`, [...params, expense.account_id])).rows;
      return { pfExpense: candidate(expense), pjOutflows: pjOutflows.map(candidate), pfInflows: pfInflows.map(candidate) };
    });
  }

  async close(): Promise<void> { await this.pool.end(); }
}
