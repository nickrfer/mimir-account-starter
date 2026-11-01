CREATE TABLE mimir.delivery_packages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES mimir.workspaces(id) ON DELETE RESTRICT,
  snapshot_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  zip_bytes bytea NOT NULL,
  zip_size integer NOT NULL CHECK (zip_size BETWEEN 1 AND 115343360),
  zip_hash text NOT NULL CHECK (zip_hash ~ '^[a-f0-9]{64}$'),
  manifest_bytes bytea NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  published_token bigint NOT NULL CHECK (published_token BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, snapshot_id),
  UNIQUE (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, snapshot_id, operation_id) REFERENCES mimir.delivery_snapshots(workspace_id, id, operation_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, operation_id, snapshot_id) REFERENCES mimir.delivery_operations(workspace_id, id, snapshot_id) ON DELETE RESTRICT,
  CHECK (octet_length(zip_bytes) = zip_size),
  CHECK (encode(sha256(zip_bytes), 'hex') = zip_hash),
  CHECK (octet_length(manifest_bytes) BETWEEN 2 AND 8388608),
  CHECK (encode(sha256(manifest_bytes), 'hex') = manifest_hash)
);

CREATE FUNCTION mimir.guard_delivery_operation_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, mimir AS $$
BEGIN
  IF OLD.status IN ('PRONTA', 'FALHA') THEN
    RAISE EXCEPTION 'Terminal delivery operation is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'EM_FILA' THEN
    IF NEW.status IS DISTINCT FROM 'EM_PROCESSAMENTO'
      OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count + 1
      OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token + 1
      OR NEW.lease_holder IS NULL THEN
      RAISE EXCEPTION 'Invalid queued delivery transition' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'EM_PROCESSAMENTO' THEN
    IF NOT ((NEW.attempt_count = OLD.attempt_count AND NEW.fencing_token = OLD.fencing_token AND NEW.lease_holder IS NOT DISTINCT FROM OLD.lease_holder)
      OR (NEW.attempt_count = OLD.attempt_count + 1 AND NEW.fencing_token = OLD.fencing_token + 1 AND NEW.lease_holder IS NOT NULL)) THEN
      RAISE EXCEPTION 'Invalid processing delivery transition' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'EM_FILA' THEN
    IF NEW.attempt_count IS DISTINCT FROM OLD.attempt_count OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
      OR NEW.lease_holder IS NOT NULL OR NEW.next_retry_at IS NULL THEN
      RAISE EXCEPTION 'Invalid retry delivery transition' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status IN ('PRONTA', 'FALHA') THEN
    IF NEW.attempt_count IS DISTINCT FROM OLD.attempt_count OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
      OR NEW.lease_holder IS NOT NULL OR NEW.completed_at IS NULL
      OR (NEW.status = 'FALHA' AND NEW.error_code IS NULL) OR (NEW.status = 'PRONTA' AND NEW.error_code IS NOT NULL) THEN
      RAISE EXCEPTION 'Invalid terminal delivery transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_operation_transition BEFORE UPDATE ON mimir.delivery_operations
FOR EACH ROW EXECUTE FUNCTION mimir.guard_delivery_operation_update();

CREATE FUNCTION mimir.check_delivery_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, mimir AS $$
DECLARE
  state mimir.delivery_operations%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'delivery_packages' THEN
    SELECT * INTO state FROM mimir.delivery_operations WHERE workspace_id = NEW.workspace_id AND id = NEW.operation_id;
    IF state.status IS DISTINCT FROM 'PRONTA' OR state.fencing_token IS DISTINCT FROM NEW.published_token THEN
      RAISE EXCEPTION 'Package published without a matching ready operation' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'PRONTA' AND NOT EXISTS (
    SELECT 1 FROM mimir.delivery_packages p WHERE p.workspace_id = NEW.workspace_id AND p.operation_id = NEW.id
      AND p.published_token = NEW.fencing_token) THEN
    RAISE EXCEPTION 'Ready operation without package' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER delivery_package_ready AFTER INSERT ON mimir.delivery_packages
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mimir.check_delivery_publication();
CREATE CONSTRAINT TRIGGER delivery_operation_ready AFTER UPDATE OF status ON mimir.delivery_operations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mimir.check_delivery_publication();

GRANT SELECT, INSERT ON mimir.delivery_packages TO mimir_runtime;
GRANT UPDATE (status, attempt_count, fencing_token, lease_holder, lease_expires_at, next_retry_at, error_code, completed_at)
  ON mimir.delivery_operations TO mimir_runtime;
