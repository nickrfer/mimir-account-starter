# Modelo lógico e integridade

A forma vigente do manifesto é v2. Leia também category-totals.md; os totais por categoria são obrigatórios. Regras referenciadas por números de seção abaixo vêm da especificação de domínio, não de arquivos institucionais.


### 4.1 Entidades e campos essenciais

UUID identifica entidades. Toda entidade do acervo tem workspaceId obrigatório. createdAt/updatedAt são instantes operacionais; nenhum timestamp substitui revision. O modelo abaixo é especificação lógica, não migração SQL executada.

| Entidade | Dados e restrições principais |
| --- | --- |
| users | id, email normalizado único, displayName, passwordHash Argon2id, active, createdAt. |
| workspaces | id, ownerId único, companyName, currency BRL, revision. Um espaço por usuário. |
| sessions | id, userId, workspaceId, tokenHash único, csrfToken, createdAt, expiresAt, revokedAt. Par user/espaço consistente. |
| periods | id, workspaceId, periodMonth, notes. Único espaço/mês. |
| accounts | id, workspaceId, name, accountType PF/PJ, active. Nome único no espaço após normalização definida. |
| transactions | id, workspaceId, accountId, occurredOn, periodMonth, direction, amountCents, description, category, classification, isPfBusinessExpense, explanation, sourceType, status e datas. |
| import_origins | id, workspaceId, accountId, sourceCode, externalId, transactionId, originalFingerprint, normalizedOriginalRow. Imutável; identidade de origem única. |
| import_batches | id, workspaceId, accountId, periodMonth, sourceCode, fileHash, contagens e instante. Histórico de confirmações com novas linhas. |
| documents | id, workspaceId, originalName, MIME, sizeBytes, hash, bytes, supersedesDocumentId opcional. Conteúdo e metadados imutáveis. |
| transaction_documents | workspaceId, transactionId, documentId. Par único; vínculo atual editável. |
| reimbursement_links | id, workspaceId, pfExpenseId, pjOutflowId, pfInflowId opcional, amountCents, status, notes. Unicidade de participantes ativos. |
| pending_items | id, workspaceId, transactionId, type, status, description, justification. Único registro por movimentação/tipo. |
| delivery_snapshots | id, workspaceId, periodMonth, versionNumber, capturedRevision, reason, capturedAt, payload JSONB completo, contagens. Imutável; versão única por espaço/mês. |
| snapshot_documents | workspaceId, snapshotId, documentId. Referências aos bytes imutáveis presentes no payload; sem duplicata. |
| delivery_operations | id, workspaceId, snapshotId único, status, attemptCount, fencingToken, leaseHolder, leaseExpiresAt, nextRetryAt, erro sanitizado e datas. |
| idempotency_keys | workspaceId, key, requestFingerprint, operationId, createdAt. Chave única no espaço, imutável. |
| delivery_packages | id, workspaceId, snapshotId único, operationId único, zipBytes, zipSize, zipHash, manifestBytes, manifestHash, publishedToken, createdAt. Imutável. |

O snapshot é um agregado JSONB completo e autoritativo: inclui nome da empresa, contas, registros do mês e de contexto, pendências, vínculos e metadados dos documentos. Esse refinamento evita depender de consultas ao acervo mutável durante a geração. Não é event sourcing. A tabela snapshot_documents fornece integridade referencial dos bytes; não é uma fonte alternativa para alterar o conteúdo capturado.

### 4.2 Relacionamentos e índices

Usar referências compostas por (workspaceId, id) entre entidades de um espaço: movimentação/conta, origem/conta/movimentação, vínculo/documento/movimentação, reembolso/participantes, pendência/movimentação e entrega/snapshot/operação/documentos. UUID globalmente único não substitui essa consistência. Validar adicionalmente tipos de conta, valores e datas na aplicação sob bloqueio. Relacionamentos operacionais redundantes devem apontar à mesma combinação de espaço e snapshot, não apenas a UUIDs existentes.

Índices mínimos: movimentações por espaço/período/status; documentos por espaço/id; vínculos por cada participante; pendências por espaço/período/status através do registro; versões por espaço/período/número; operações por status/nextRetryAt/leaseExpiresAt; sessões por hash; origem pela chave natural. Índices únicos parciais devem impedir reutilizar cada participante em dois reembolsos ativos. ON DELETE RESTRICT protege referências históricas; exclusão do acervo é lógica. Para unicidade de nomes de contas, armazenar chave auxiliar obtida por NFC, trim e conversão para minúsculas consistente no serviço; não depender da collation implícita do ambiente.

### 4.3 Imutabilidade e fechamento de agregados

Permitir somente INSERT/SELECT em documentos, origens, snapshots, suas referências, chaves idempotentes e pacotes. API não é proprietária, superusuária nem membro do papel migrador; não recebe DDL ou TRUNCATE. Revogar privilégios públicos que possibilitem criação de objetos no schema usado pela aplicação. Credenciais de migração/provisionamento nunca ficam no processo da API ou do executor.

Impedir UPDATE/DELETE não impede sozinho acrescentar filhos a um snapshot antigo. Por isso o payload imutável é a autoridade da seleção, e a integridade transacional deve exigir igualdade exata entre seus documentIds e as referências em snapshot_documents ao final da captura. A implementação deverá também rejeitar inserção posterior de referências que não pertençam ao payload; inserções duplicadas são barradas pela chave única. Um constraint trigger diferido é uma opção de implementação a validar; o comportamento exigido é rollback de agregado incompleto ou divergente no commit. Esses mecanismos não são apresentados como já implementados.

O empacotador lê somente o payload do snapshot e os bytes dos documentIds nele declarados. Não lê nome da conta, pendência, empresa, descrição ou reembolso atuais. Falta ou divergência de hash de um documento capturado causa falha da tentativa, nunca omissão silenciosa. A proteção não resiste a um administrador que altere deliberadamente esquema ou permissões; esse limite deve constar da documentação de segurança.

