CREATE TABLE mimir.import_origins (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES mimir.workspaces(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  source_code text NOT NULL CHECK (length(source_code) BETWEEN 1 AND 80),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  transaction_id uuid NOT NULL,
  original_fingerprint text NOT NULL CHECK (original_fingerprint ~ '^[0-9a-f]{64}$'),
  normalized_original_row jsonb NOT NULL CHECK (jsonb_typeof(normalized_original_row) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, account_id, source_code, external_id),
  UNIQUE (workspace_id, transaction_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES mimir.accounts(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, transaction_id) REFERENCES mimir.transactions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE mimir.import_batches (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES mimir.workspaces(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  period_month text NOT NULL,
  source_code text NOT NULL CHECK (length(source_code) BETWEEN 1 AND 80),
  file_hash text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 1000),
  inserted_count integer NOT NULL CHECK (inserted_count BETWEEN 1 AND row_count),
  ignored_count integer NOT NULL CHECK (ignored_count >= 0),
  repeated_count integer NOT NULL CHECK (repeated_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (inserted_count + ignored_count + repeated_count = row_count),
  FOREIGN KEY (workspace_id, account_id) REFERENCES mimir.accounts(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, period_month) REFERENCES mimir.periods(workspace_id, period_month) ON DELETE RESTRICT
);

CREATE INDEX import_batches_account ON mimir.import_batches(workspace_id, account_id, source_code);

GRANT SELECT, INSERT ON mimir.import_origins TO mimir_runtime;
GRANT SELECT, INSERT ON mimir.import_batches TO mimir_runtime;

-- Provenance is identity: the runtime has table-wide UPDATE on transactions, so the database guards these columns.
CREATE FUNCTION mimir.guard_transaction_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, mimir AS $$
BEGIN
  IF (NEW.source_type, NEW.source_code, NEW.external_id) IS DISTINCT FROM (OLD.source_type, OLD.source_code, OLD.external_id) THEN
    RAISE EXCEPTION 'Transaction provenance is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transaction_provenance_guard
BEFORE UPDATE ON mimir.transactions
FOR EACH ROW EXECUTE FUNCTION mimir.guard_transaction_provenance();
