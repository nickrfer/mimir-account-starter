GRANT UPDATE (description) ON mimir.pending_items TO mimir_runtime;

-- Only manual questions have editable text; identity of any pending item never changes.
CREATE FUNCTION mimir.guard_pending_item_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, mimir AS $$
BEGIN
  IF (NEW.id, NEW.workspace_id, NEW.transaction_id, NEW.type, NEW.created_at)
      IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.transaction_id, OLD.type, OLD.created_at)
    OR (NEW.description IS DISTINCT FROM OLD.description AND OLD.type <> 'DUVIDA_CADASTRADA') THEN
    RAISE EXCEPTION 'Invalid pending item update' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pending_item_update_guard
BEFORE UPDATE ON mimir.pending_items
FOR EACH ROW EXECUTE FUNCTION mimir.guard_pending_item_update();
