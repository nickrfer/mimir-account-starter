# Contratos HTTP e segurança

A forma vigente do manifesto é v2. Leia também category-totals.md; os totais por categoria são obrigatórios. Regras referenciadas por números de seção abaixo vêm da especificação de domínio, não de arquivos institucionais.


### 5.1 Convenções

Prefixo /api/v1, JSON UTF-8, campos camelCase, UUIDs e datas validados. Campos extras de comandos são rejeitados. A identidade do espaço vem da sessão; nenhum comando aceita ownerId ou workspaceId escolhido pelo cliente. GET não muda acervo. Valores monetários e revision seguem os limites seguros descritos. Todos os erros têm code, message e requestId; detalhes só contêm campos seguros. Não retornar SQL, senha, token, bytes de documentos ou existência de objetos de outro proprietário.

401: sessão ausente, inválida ou expirada. 403: CSRF inválido. 404: objeto inexistente ou de outro proprietário. 409: revisão obsoleta, chave idempotente incompatível ou conflito de domínio. 413: tamanho excessivo. 415: tipo de arquivo não aceito. 422: conteúdo semanticamente inválido. 429: limite de tentativas de login. 500: falha interna sanitizada; não interpretar erro HTTP como prova de rollback quando a conexão caiu após commit.

Idempotency-Key é exigida na captura, de 16–128 caracteres ASCII em [A-Za-z0-9_-], recomendando UUID aleatório. A chave é única por espaço e não por mês. Não reaproveitar uma chave com revisão ou motivo alterados. O endpoint de estado retorna FALHA com HTTP 200; falha do trabalho não é falha de transporte. Nova geração após FALHA exige novo comando, nova chave e revisão atual; histórico e versão consumida são mantidos.

### 5.2 Sessões e autenticação

Provisionamento inicial é CLI administrativa separada, sem endpoint público de cadastro. I02 implementa create-owner por stdin; parâmetros Argon2id e medição real estão em authentication.md e docs/evidence/I02-argon2.json. Sessão usa token opaco aleatório de 32 bytes; banco guarda SHA-256 do token, não o token bruto. Login cria sessão nova e revoga a sessão anterior apresentada pelo mesmo navegador, quando válida.

Cookie mimir_session é HttpOnly, SameSite=Lax, Path=/ e Secure em HTTPS; localhost HTTP tem exceção explícita apenas para desenvolvimento local. Prazo absoluto inicial de sessão: 8 horas, sem renovação deslizante, como decisão desta especificação. Logout revoga a sessão e remove o cookie. Token CSRF é retornado por login e GET /session e exigido em todas as mutações autenticadas. Login verifica Origin contra origem configurada e aceita apenas JSON; não se abre CORS genérico com credenciais.

Limitar login a 5 falhas por combinação conta/IP em 15 minutos, com resposta genérica e Retry-After; esse controle deve ter comportamento documentado em reinício, sem alegar bloqueio distribuído persistente se o contador estiver apenas em memória. Não manter senhas padrão embutidas. Logar requestId, operação, resultado e duração, sem credenciais ou conteúdo financeiro. Dados sintéticos são usados em testes e demonstrações.

### 5.3 Jornada inicial documentada em OpenAPI

| Método e recurso | Contrato principal |
| --- | --- |
| POST /session | email/password; 200 com usuário, espaço, revision e csrfToken; cookie novo. |
| GET /session | Sessão autenticada; 200 com contexto e csrfToken. |
| DELETE /session | CSRF; 204 e cookie removido. |
| GET e POST /accounts | Listagem própria; criação PF/PJ com expectedRevision; 201 com conta e nova revisão. |
| POST /transactions | Conta, data, direção, centavos, classificação e textos; expectedRevision; 201 com registro e revisão. |
| POST /transactions/{id}/documents | multipart com file e expectedRevision; cria bytes e vínculo atomicamente; 201. |
| GET /periods/{month}/preview | 200 com visão consistente, revision, totais, registros, contexto, vínculos e pendências. |
| POST /deliveries | Idempotency-Key, periodMonth, expectedRevision e rectificationReason; 202 se não terminal, 200 se repetição terminal. |
| GET /operations/{id} | Estado, tentativas, snapshotId e erro público; sem tokens internos de posse. |
| GET /periods/{month}/deliveries | Histórico ordenado por versão; inclui entregas em processamento e falhas. |
| GET /deliveries/{snapshotId}/package | ZIP pronto, Content-Disposition; 409 se não pronto. |
| GET /deliveries/{snapshotId}/manifest | Bytes exatos do manifesto publicado, 409 se não pronto. Cópia externa de referência. |

O OpenAPI no pacote descreve estes endpoints da primeira jornada. Ele é contrato, não servidor funcional. Os recursos complementares abaixo têm especificação textual e aceites; devem receber OpenAPI detalhado antes de sua implementação. Não há alegação de cobertura HTTP integral dos 14 RF neste arquivo inicial.

### 5.4 Recursos complementares

Períodos: GET /periods e POST /periods com periodMonth/notes/expectedRevision; atualização de notas via PATCH /periods/{month}. A primeira movimentação pode criar automaticamente seu período na mesma transação, com um único incremento de revision. Consulta de mês válido sem dados retorna prévia vazia. Não permitir captura vazia: 422 EMPTY_PERIOD.

Movimentações: GET /transactions?periodMonth=, GET /transactions/{id}, PATCH /transactions/{id} com alterações e expectedRevision, DELETE /transactions/{id} com expectedRevision. A exclusão é lógica; segunda exclusão de objeto já excluído retorna 409, sem novo incremento. Para contas, PATCH /accounts/{id} permite renomear/inativar, mas não trocar PF/PJ após uso. Inativar impede novos registros, preservando histórico e leituras.

CSV: POST /imports/preview recebe arquivo, accountId, sourceCode e periodMonth, retorna fileHash, revision, linhas válidas/ignoradas/conflitantes/inválidas e totais. POST /imports/confirm recebe o mesmo conjunto, expectedFileHash e expectedRevision. Confirmação atômica retorna contagens e revisão; não há confirmação parcial de linhas inválidas.

Documentos: GET /documents/{id}/content autorizado; POST /transactions/{id}/document-links para anexar documento existente; DELETE /transactions/{id}/document-links/{documentId} para desvincular; POST /transactions/{id}/document-replacements com documento antigo e novo upload. Todas as mutações usam expectedRevision e CSRF. Substituição afeta o vínculo indicado, não todos os usos do documento no acervo.

Reembolsos: POST /reimbursements recebe pfExpenseId, pjOutflowId, pfInflowId opcional, notes e expectedRevision; GET /reimbursements?periodMonth=; DELETE /reimbursements/{id} desfaz logicamente. Pendências: GET /pending-items?periodMonth=; POST /transactions/{id}/questions registra dúvida; PATCH /pending-items/{id} registra justificativa ou resolve/reabre dúvida manual. Pendência automática não é resolvida manualmente sem eliminar sua causa; justificá-la continua permitido.

Listagens do acervo usam paginação por cursor estável com limite padrão 100 e máximo 200; prévia e snapshot retornam a seleção completa limitada a 1.000 registros. Filtrar proprietário antes de paginar; cursor de outro espaço não abre acesso. Ordenações documentadas: movimentações por data/id; versões por versionNumber; pendências por tipo/id. Esses recursos futuros não exigem novo serviço, fila externa ou cache.

