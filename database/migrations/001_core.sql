CREATE TABLE mimir.users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE mimir.workspaces (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL UNIQUE REFERENCES mimir.users(id) ON DELETE RESTRICT,
  company_name text NOT NULL CHECK (length(company_name) BETWEEN 1 AND 200),
  currency text NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  UNIQUE (id, owner_id)
);

CREATE TABLE mimir.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, user_id) REFERENCES mimir.workspaces(id, owner_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

CREATE TABLE mimir.accounts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES mimir.workspaces(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  name_key text NOT NULL CHECK (length(name_key) BETWEEN 1 AND 200),
  account_type text NOT NULL CHECK (account_type IN ('PF', 'PJ')),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, name_key)
);

CREATE TABLE mimir.periods (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES mimir.workspaces(id) ON DELETE RESTRICT,
  period_month text NOT NULL CHECK (period_month ~ '^(19[0-9]{2}|[2-9][0-9]{3})-(0[1-9]|1[0-2])$'),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, period_month)
);

CREATE TABLE mimir.transactions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES mimir.workspaces(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  occurred_on date NOT NULL CHECK (occurred_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  period_month text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('ENTRADA', 'SAIDA')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 99999999999),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 100),
  classification text NOT NULL CHECK (classification IN ('RECEITA', 'DESPESA', 'TRANSFERENCIA', 'A_ESCLARECER')),
  is_pf_business_expense boolean NOT NULL DEFAULT false,
  explanation text NOT NULL DEFAULT '' CHECK (length(explanation) <= 2000),
  source_type text NOT NULL CHECK (source_type IN ('MANUAL', 'CSV')),
  source_code text NOT NULL CHECK (length(source_code) BETWEEN 1 AND 80),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'ATIVA' CHECK (status IN ('ATIVA', 'EXCLUIDA')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES mimir.accounts(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, period_month) REFERENCES mimir.periods(workspace_id, period_month) ON DELETE RESTRICT,
  CHECK (period_month = to_char(occurred_on, 'YYYY-MM')),
  CHECK (classification <> 'RECEITA' OR direction = 'ENTRADA'),
  CHECK (classification <> 'DESPESA' OR direction = 'SAIDA'),
  CHECK (NOT is_pf_business_expense OR (classification = 'DESPESA' AND direction = 'SAIDA'))
);
CREATE INDEX transactions_period_status ON mimir.transactions(workspace_id, period_month, status);
CREATE INDEX transactions_account ON mimir.transactions(workspace_id, account_id);

CREATE TABLE mimir.documents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES mimir.workspaces(id) ON DELETE RESTRICT,
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  mime text NOT NULL CHECK (mime IN ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
  bytes bytea NOT NULL,
  supersedes_document_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, supersedes_document_id) REFERENCES mimir.documents(workspace_id, id) ON DELETE RESTRICT,
  CHECK (supersedes_document_id IS DISTINCT FROM id),
  CHECK (octet_length(bytes) = size_bytes),
  CHECK (encode(sha256(bytes), 'hex') = hash)
);
CREATE INDEX documents_supersedes ON mimir.documents(workspace_id, supersedes_document_id);

CREATE TABLE mimir.transaction_documents (
  workspace_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  document_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, transaction_id, document_id),
  FOREIGN KEY (workspace_id, transaction_id) REFERENCES mimir.transactions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, document_id) REFERENCES mimir.documents(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX transaction_documents_document ON mimir.transaction_documents(workspace_id, document_id);

GRANT SELECT ON mimir.users, mimir.workspaces TO mimir_runtime;
GRANT UPDATE (revision) ON mimir.workspaces TO mimir_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON mimir.sessions TO mimir_runtime;
GRANT SELECT, INSERT, UPDATE ON mimir.accounts, mimir.periods, mimir.transactions TO mimir_runtime;
GRANT SELECT, INSERT ON mimir.documents TO mimir_runtime;
GRANT SELECT, INSERT, DELETE ON mimir.transaction_documents TO mimir_runtime;
