CREATE TABLE mimir.delivery_snapshots (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES mimir.workspaces(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  period_month text NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  captured_revision bigint NOT NULL CHECK (captured_revision BETWEEN 1 AND 9007199254740991),
  rectification_reason text NOT NULL DEFAULT '' CHECK (length(rectification_reason) <= 2000),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL,
  transaction_count integer NOT NULL CHECK (transaction_count BETWEEN 1 AND 1000),
  document_count integer NOT NULL CHECK (document_count BETWEEN 0 AND 1000),
  document_bytes bigint NOT NULL CHECK (document_bytes BETWEEN 0 AND 104857600),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, period_month, version_number),
  UNIQUE (workspace_id, id, operation_id),
  FOREIGN KEY (workspace_id, period_month) REFERENCES mimir.periods(workspace_id, period_month) ON DELETE RESTRICT,
  CHECK (version_number = 1 OR length(btrim(rectification_reason)) BETWEEN 3 AND 2000),
  CHECK (octet_length(convert_to(payload::text, 'UTF8')) <= 8388608)
);

CREATE TABLE mimir.delivery_operations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES mimir.workspaces(id) ON DELETE RESTRICT,
  snapshot_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'EM_FILA' CHECK (status IN ('EM_FILA', 'EM_PROCESSAMENTO', 'PRONTA', 'FALHA')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token BETWEEN 0 AND 9007199254740991),
  lease_holder text,
  lease_expires_at timestamptz,
  next_retry_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, snapshot_id),
  UNIQUE (workspace_id, id, snapshot_id),
  FOREIGN KEY (workspace_id, snapshot_id, id) REFERENCES mimir.delivery_snapshots(workspace_id, id, operation_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ((lease_holder IS NULL) = (lease_expires_at IS NULL)),
  CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 100 AND error_code ~ '^[A-Z0-9_]+$'))
);

ALTER TABLE mimir.delivery_snapshots ADD CONSTRAINT delivery_snapshots_operation_fk
  FOREIGN KEY (workspace_id, operation_id, id) REFERENCES mimir.delivery_operations(workspace_id, id, snapshot_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX delivery_operations_queue ON mimir.delivery_operations(status, next_retry_at, lease_expires_at);

CREATE TABLE mimir.snapshot_documents (
  workspace_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  document_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, snapshot_id, document_id),
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES mimir.delivery_snapshots(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, document_id) REFERENCES mimir.documents(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX snapshot_documents_document ON mimir.snapshot_documents(workspace_id, document_id);

CREATE TABLE mimir.idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES mimir.workspaces(id) ON DELETE RESTRICT,
  key text NOT NULL CHECK (key COLLATE "C" ~ '^[A-Za-z0-9_-]{16,128}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, key),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES mimir.delivery_operations(workspace_id, id) ON DELETE RESTRICT
);

-- Constraint triggers run at commit, after snapshot, operation and references are inserted.
CREATE FUNCTION mimir.check_delivery_snapshot_closure() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, mimir AS $$
DECLARE
  captured mimir.delivery_snapshots%ROWTYPE;
  metadata jsonb;
  transaction jsonb;
  document_id jsonb;
  metadata_ids text[] := ARRAY[]::text[];
  transaction_ids text[] := ARRAY[]::text[];
  reference_ids text[];
  unique_metadata_ids text[];
  unique_transaction_ids text[];
  bytes_total bigint := 0;
  association_count integer := 0;
  transaction_total integer;
  actual_name text;
  actual_mime text;
  actual_size integer;
  actual_hash text;
BEGIN
  IF TG_TABLE_NAME = 'snapshot_documents' THEN
    SELECT * INTO captured FROM mimir.delivery_snapshots
      WHERE workspace_id = NEW.workspace_id AND id = NEW.snapshot_id;
    -- The snapshot INSERT trigger validates the whole set once. Later child
    -- inserts can only mention an ID already declared in the immutable payload.
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(captured.payload->'documents') AS listed(value)
      WHERE listed.value->>'documentId' = NEW.document_id::text
    ) THEN
      RAISE EXCEPTION 'Snapshot document absent from payload' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  ELSE
    SELECT * INTO captured FROM mimir.delivery_snapshots
      WHERE workspace_id = NEW.workspace_id AND id = NEW.id;
  END IF;

  IF jsonb_typeof(captured.payload) IS DISTINCT FROM 'object'
    OR captured.payload->>'schemaVersion' IS DISTINCT FROM 'mimir.snapshot.v1'
    OR jsonb_typeof(captured.payload->'workspace') IS DISTINCT FROM 'object'
    OR captured.payload#>>'{workspace,workspaceId}' IS DISTINCT FROM captured.workspace_id::text
    OR jsonb_typeof(captured.payload->'delivery') IS DISTINCT FROM 'object'
    OR captured.payload#>>'{delivery,snapshotId}' IS DISTINCT FROM captured.id::text
    OR captured.payload#>>'{delivery,operationId}' IS DISTINCT FROM captured.operation_id::text
    OR captured.payload#>>'{delivery,periodMonth}' IS DISTINCT FROM captured.period_month
    OR captured.payload#>>'{delivery,versionNumber}' IS DISTINCT FROM captured.version_number::text
    OR captured.payload#>>'{delivery,capturedRevision}' IS DISTINCT FROM captured.captured_revision::text
    OR captured.payload#>>'{delivery,rectificationReason}' IS DISTINCT FROM captured.rectification_reason
    OR jsonb_typeof(captured.payload->'period') IS DISTINCT FROM 'object'
    OR captured.payload#>>'{period,periodMonth}' IS DISTINCT FROM captured.period_month
    OR jsonb_typeof(captured.payload->'summary') IS DISTINCT FROM 'object'
    OR jsonb_typeof(captured.payload->'transactions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(captured.payload->'contextTransactions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(captured.payload->'documents') IS DISTINCT FROM 'array'
    OR jsonb_typeof(captured.payload->'reimbursementLinks') IS DISTINCT FROM 'array'
    OR jsonb_typeof(captured.payload->'pendingItems') IS DISTINCT FROM 'array'
    OR captured.payload#>>'{delivery,capturedAt}' IS NULL
  THEN
    RAISE EXCEPTION 'Invalid delivery snapshot payload' USING ERRCODE = '23514';
  END IF;

  IF (captured.payload#>>'{delivery,capturedAt}')::timestamptz IS DISTINCT FROM captured.captured_at THEN
    RAISE EXCEPTION 'Delivery capture time mismatch' USING ERRCODE = '23514';
  END IF;

  transaction_total := jsonb_array_length(captured.payload->'transactions')
    + jsonb_array_length(captured.payload->'contextTransactions');
  IF transaction_total IS DISTINCT FROM captured.transaction_count OR transaction_total > 1000
    OR jsonb_array_length(captured.payload->'transactions') = 0 THEN
    RAISE EXCEPTION 'Delivery transaction count mismatch' USING ERRCODE = '23514';
  END IF;

  FOR metadata IN SELECT value FROM jsonb_array_elements(captured.payload->'documents') LOOP
    IF jsonb_typeof(metadata) IS DISTINCT FROM 'object'
      OR coalesce(metadata->>'documentId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$', false) IS NOT TRUE
      OR jsonb_typeof(metadata->'sizeBytes') IS DISTINCT FROM 'number'
      OR coalesce(metadata->>'sizeBytes' ~ '^[1-9][0-9]*$', false) IS NOT TRUE
      OR (metadata->>'sizeBytes')::bigint > 5242880
      OR jsonb_typeof(metadata->'originalName') IS DISTINCT FROM 'string'
      OR jsonb_typeof(metadata->'mimeType') IS DISTINCT FROM 'string'
      OR coalesce(metadata->>'sha256' ~ '^[a-f0-9]{64}$', false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Invalid snapshot document metadata' USING ERRCODE = '23514';
    END IF;
    metadata_ids := array_append(metadata_ids, metadata->>'documentId');
    bytes_total := bytes_total + (metadata->>'sizeBytes')::bigint;
    SELECT d.original_name, d.mime, d.size_bytes, d.hash
      INTO actual_name, actual_mime, actual_size, actual_hash
      FROM mimir.documents AS d
      WHERE d.workspace_id = captured.workspace_id AND d.id = (metadata->>'documentId')::uuid;
    IF NOT FOUND OR metadata->>'originalName' IS DISTINCT FROM actual_name
      OR metadata->>'mimeType' IS DISTINCT FROM actual_mime
      OR (metadata->>'sizeBytes')::integer IS DISTINCT FROM actual_size
      OR metadata->>'sha256' IS DISTINCT FROM actual_hash THEN
      RAISE EXCEPTION 'Snapshot document metadata mismatch' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF cardinality(metadata_ids) IS DISTINCT FROM captured.document_count
    OR bytes_total IS DISTINCT FROM captured.document_bytes
    OR bytes_total > 104857600 THEN
    RAISE EXCEPTION 'Delivery document totals mismatch' USING ERRCODE = '23514';
  END IF;

  FOR transaction IN
    SELECT value FROM jsonb_array_elements(captured.payload->'transactions')
    UNION ALL
    SELECT value FROM jsonb_array_elements(captured.payload->'contextTransactions')
  LOOP
    IF jsonb_typeof(transaction) IS DISTINCT FROM 'object'
      OR jsonb_typeof(transaction->'documentIds') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid snapshot transaction documents' USING ERRCODE = '23514';
    END IF;
    FOR document_id IN SELECT value FROM jsonb_array_elements(transaction->'documentIds') LOOP
      IF jsonb_typeof(document_id) IS DISTINCT FROM 'string'
        OR document_id#>>'{}' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
        RAISE EXCEPTION 'Invalid snapshot transaction document ID' USING ERRCODE = '23514';
      END IF;
      transaction_ids := array_append(transaction_ids, document_id#>>'{}');
      association_count := association_count + 1;
      IF association_count > 10000 THEN
        RAISE EXCEPTION 'Too many snapshot document associations' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END LOOP;

  SELECT coalesce(array_agg(DISTINCT v ORDER BY v), ARRAY[]::text[]) INTO unique_metadata_ids
    FROM unnest(metadata_ids) AS v;
  SELECT coalesce(array_agg(DISTINCT v ORDER BY v), ARRAY[]::text[]) INTO unique_transaction_ids
    FROM unnest(transaction_ids) AS v;
  SELECT coalesce(array_agg(sd.document_id::text ORDER BY sd.document_id::text), ARRAY[]::text[])
    INTO reference_ids FROM mimir.snapshot_documents AS sd
    WHERE sd.workspace_id = captured.workspace_id AND sd.snapshot_id = captured.id;

  IF cardinality(unique_metadata_ids) IS DISTINCT FROM cardinality(metadata_ids)
    OR unique_metadata_ids IS DISTINCT FROM unique_transaction_ids
    OR unique_metadata_ids IS DISTINCT FROM reference_ids THEN
    RAISE EXCEPTION 'Delivery snapshot document closure mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER delivery_snapshot_closure
AFTER INSERT ON mimir.delivery_snapshots DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION mimir.check_delivery_snapshot_closure();

CREATE CONSTRAINT TRIGGER snapshot_document_closure
AFTER INSERT ON mimir.snapshot_documents DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION mimir.check_delivery_snapshot_closure();

GRANT SELECT, INSERT ON mimir.delivery_snapshots, mimir.snapshot_documents,
  mimir.delivery_operations, mimir.idempotency_keys TO mimir_runtime;
