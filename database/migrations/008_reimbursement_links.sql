CREATE TABLE mimir.reimbursement_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES mimir.workspaces(id) ON DELETE RESTRICT,
  pf_expense_id uuid NOT NULL,
  pj_outflow_id uuid NOT NULL,
  pf_inflow_id uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 99999999999),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  status text NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('ATIVO', 'DESFEITO')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  undone_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, pf_expense_id) REFERENCES mimir.transactions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, pj_outflow_id) REFERENCES mimir.transactions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, pf_inflow_id) REFERENCES mimir.transactions(workspace_id, id) ON DELETE RESTRICT,
  CHECK (pf_expense_id <> pj_outflow_id),
  CHECK (pf_inflow_id IS NULL OR (pf_inflow_id <> pf_expense_id AND pf_inflow_id <> pj_outflow_id)),
  CHECK ((status = 'ATIVO') = (undone_at IS NULL)),
  CHECK (undone_at IS NULL OR undone_at >= created_at)
);
CREATE UNIQUE INDEX reimbursement_links_active_pf_expense ON mimir.reimbursement_links(workspace_id, pf_expense_id) WHERE status = 'ATIVO';
CREATE UNIQUE INDEX reimbursement_links_active_pj_outflow ON mimir.reimbursement_links(workspace_id, pj_outflow_id) WHERE status = 'ATIVO';
CREATE UNIQUE INDEX reimbursement_links_active_pf_inflow ON mimir.reimbursement_links(workspace_id, pf_inflow_id) WHERE status = 'ATIVO' AND pf_inflow_id IS NOT NULL;
CREATE INDEX reimbursement_links_pf_expense ON mimir.reimbursement_links(workspace_id, pf_expense_id);
CREATE INDEX reimbursement_links_pj_outflow ON mimir.reimbursement_links(workspace_id, pj_outflow_id);
CREATE INDEX reimbursement_links_pf_inflow ON mimir.reimbursement_links(workspace_id, pf_inflow_id);

CREATE FUNCTION mimir.validate_reimbursement_link() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, mimir AS $$
DECLARE
  expense record;
  outflow record;
  inflow record;
BEGIN
  IF NEW.status IS DISTINCT FROM 'ATIVO' OR NEW.undone_at IS NOT NULL THEN
    RAISE EXCEPTION 'Reimbursement link must start active' USING ERRCODE = '23514';
  END IF;
  SELECT t.account_id, t.occurred_on, t.direction, t.amount_cents, t.classification, t.is_pf_business_expense, t.status, a.account_type
    INTO expense FROM mimir.transactions t JOIN mimir.accounts a ON (a.workspace_id, a.id) = (t.workspace_id, t.account_id)
    WHERE t.workspace_id = NEW.workspace_id AND t.id = NEW.pf_expense_id;
  SELECT t.account_id, t.occurred_on, t.direction, t.amount_cents, t.classification, t.is_pf_business_expense, t.status, a.account_type
    INTO outflow FROM mimir.transactions t JOIN mimir.accounts a ON (a.workspace_id, a.id) = (t.workspace_id, t.account_id)
    WHERE t.workspace_id = NEW.workspace_id AND t.id = NEW.pj_outflow_id;
  IF expense IS NULL OR outflow IS NULL
    OR expense.status <> 'ATIVA' OR expense.account_type <> 'PF' OR expense.direction <> 'SAIDA'
    OR expense.classification <> 'DESPESA' OR NOT expense.is_pf_business_expense
    OR outflow.status <> 'ATIVA' OR outflow.account_type <> 'PJ' OR outflow.direction <> 'SAIDA'
    OR outflow.classification <> 'TRANSFERENCIA' OR outflow.is_pf_business_expense
    OR expense.amount_cents <> NEW.amount_cents OR outflow.amount_cents <> NEW.amount_cents
    OR outflow.occurred_on < expense.occurred_on THEN
    RAISE EXCEPTION 'Invalid reimbursement participants' USING ERRCODE = '23514';
  END IF;
  IF NEW.pf_inflow_id IS NOT NULL THEN
    SELECT t.account_id, t.occurred_on, t.direction, t.amount_cents, t.classification, t.is_pf_business_expense, t.status
      INTO inflow FROM mimir.transactions t WHERE t.workspace_id = NEW.workspace_id AND t.id = NEW.pf_inflow_id;
    IF inflow IS NULL OR inflow.status <> 'ATIVA' OR inflow.account_id <> expense.account_id
      OR inflow.direction <> 'ENTRADA' OR inflow.classification <> 'TRANSFERENCIA' OR inflow.is_pf_business_expense
      OR inflow.amount_cents <> NEW.amount_cents OR inflow.occurred_on < outflow.occurred_on THEN
      RAISE EXCEPTION 'Invalid reimbursement PF inflow' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reimbursement_link_participants
BEFORE INSERT ON mimir.reimbursement_links
FOR EACH ROW EXECUTE FUNCTION mimir.validate_reimbursement_link();

-- Links are never reactivated or re-pointed: undoing is the only transition.
CREATE FUNCTION mimir.guard_reimbursement_link_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, mimir AS $$
BEGIN
  IF OLD.status <> 'ATIVO' OR NEW.status <> 'DESFEITO' OR NEW.undone_at IS NULL
    OR (NEW.id, NEW.workspace_id, NEW.pf_expense_id, NEW.pj_outflow_id, NEW.amount_cents, NEW.notes, NEW.created_at)
      IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.pf_expense_id, OLD.pj_outflow_id, OLD.amount_cents, OLD.notes, OLD.created_at)
    OR NEW.pf_inflow_id IS DISTINCT FROM OLD.pf_inflow_id THEN
    RAISE EXCEPTION 'Invalid reimbursement link transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reimbursement_link_transition
BEFORE UPDATE ON mimir.reimbursement_links
FOR EACH ROW EXECUTE FUNCTION mimir.guard_reimbursement_link_update();

-- Linked movements keep the facts the link was validated against; text fields remain editable.
CREATE FUNCTION mimir.guard_linked_transaction_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, mimir AS $$
BEGIN
  IF (NEW.account_id, NEW.occurred_on, NEW.period_month, NEW.direction, NEW.amount_cents, NEW.classification, NEW.is_pf_business_expense, NEW.status)
      IS DISTINCT FROM (OLD.account_id, OLD.occurred_on, OLD.period_month, OLD.direction, OLD.amount_cents, OLD.classification, OLD.is_pf_business_expense, OLD.status)
    AND EXISTS (SELECT 1 FROM mimir.reimbursement_links l WHERE l.workspace_id = OLD.workspace_id AND l.status = 'ATIVO'
      AND OLD.id IN (l.pf_expense_id, l.pj_outflow_id, l.pf_inflow_id)) THEN
    RAISE EXCEPTION 'Linked transaction cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transaction_reimbursement_guard
BEFORE UPDATE ON mimir.transactions
FOR EACH ROW EXECUTE FUNCTION mimir.guard_linked_transaction_update();

GRANT SELECT, INSERT ON mimir.reimbursement_links TO mimir_runtime;
GRANT UPDATE (status, undone_at) ON mimir.reimbursement_links TO mimir_runtime;
