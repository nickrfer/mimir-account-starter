-- The public name remains <=200 characters. Unicode lowercase can expand its derived key.
ALTER TABLE mimir.accounts DROP CONSTRAINT accounts_name_key_check;
ALTER TABLE mimir.accounts ADD CONSTRAINT accounts_name_key_check CHECK (length(name_key) >= 1);
