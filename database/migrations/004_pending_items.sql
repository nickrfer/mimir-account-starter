CREATE TABLE mimir.pending_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES mimir.workspaces(id) ON DELETE RESTRICT,
  transaction_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('DOCUMENTO_AUSENTE','CLASSIFICACAO_A_ESCLARECER','REEMBOLSO_PF_PENDENTE','DUVIDA_CADASTRADA')),
  status text NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','JUSTIFICADA','RESOLVIDA')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  justification text NOT NULL DEFAULT '' CHECK (length(justification) <= 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id,id),
  UNIQUE (workspace_id,transaction_id,type),
  FOREIGN KEY (workspace_id,transaction_id) REFERENCES mimir.transactions(workspace_id,id) ON DELETE RESTRICT,
  CHECK (status <> 'JUSTIFICADA' OR length(btrim(justification)) BETWEEN 3 AND 2000)
);
CREATE INDEX pending_items_status_transaction ON mimir.pending_items(workspace_id,status,transaction_id);
GRANT SELECT,INSERT ON mimir.pending_items TO mimir_runtime;
