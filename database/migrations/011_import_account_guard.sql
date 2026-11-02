-- An imported transaction's account is part of its origin identity in import_origins; changing it would orphan the origin.
CREATE FUNCTION mimir.guard_imported_transaction_account() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, mimir AS $$
BEGIN
  IF OLD.source_type = 'CSV' AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'Imported transaction account is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER imported_transaction_account_guard
BEFORE UPDATE ON mimir.transactions
FOR EACH ROW EXECUTE FUNCTION mimir.guard_imported_transaction_account();
