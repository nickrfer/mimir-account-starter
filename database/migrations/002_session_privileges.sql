-- Session lifecycle only needs revocation; identity, token and lifetime are immutable to runtime updates.
REVOKE UPDATE, DELETE ON mimir.sessions FROM mimir_runtime;
GRANT UPDATE (revoked_at) ON mimir.sessions TO mimir_runtime;
