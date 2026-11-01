-- Only mutable reconciliation fields; document bytes and metadata remain INSERT/SELECT only.
GRANT UPDATE (status, justification, updated_at) ON mimir.pending_items TO mimir_runtime;
