# Migrações

001_core.sql implementa oito tabelas de I01 e permanece inalterada. 002_session_privileges.sql restringe sessions a SELECT/INSERT e UPDATE(revoked_at). 003_account_name_key.sql remove apenas teto interno da chave Unicode derivada, preservando limite do nome público e unicidade.

004_pending_items.sql, de I04, cria pendências com FK composta espaço/transação, unicidade por transação/tipo e constraints de tipo/estado/justificativa. Runtime recebe somente SELECT/INSERT; ciclo de atualização aguarda comandos posteriores. Não editar SQL anterior já aplicado.

Administrador provisiona papéis/schema; migrador aplica SQL ordenado sob transação/advisory lock e rastreia versão/SHA-256. Repetição não reaplica, checksum divergente aborta e falha reverte DDL/histórico juntos. Na raiz: docker compose run --build --rm admin migrate. Sem cascatas destrutivas ou credenciais no SQL. Snapshots/executor ficam para etapas posteriores.

005_document_pending_reconciliation.sql concede somente UPDATE(status,justification,updated_at) em pending_items para reconciliação no upload. Tipo/descrição/identidade permanecem protegidos; documentos continuam somente INSERT/SELECT. Migrações 001–004 preservadas.
