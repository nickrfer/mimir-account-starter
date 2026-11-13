# I03 - contas e revisão do acervo

Implementados somente GET/POST `/api/v1/accounts`, conforme OpenAPI vigente. Sem UI, consulta de conta individual, edição, inativação ou exclusão; recursos complementares aguardam contrato detalhado/incremento próprio. I04 e IA não fazem parte desta etapa.

## Criar conta

Sessão válida, Origin exata permitida e X-CSRF-Token obrigatório. Corpo JSON UTF-8 até 8 KiB com exatamente:

```json
{"name":"Conta pessoal","accountType":"PF","expectedRevision":1}
```

accountType aceita PF/PJ. Nome público tem 1–200 caracteres Unicode, sem NUL, tanto na entrada quanto após NFC/trim; normalização que exceda limite retorna 422. Espaços vazios são rejeitados. name_key é interno, derivado com minúsculas JavaScript, único por espaço, não recebido nem devolvido pela API. Maiúsculas/acentos compostos/decompostos e espaços periféricos não permitem duplicar o mesmo nome normalizado. A mesma chave pode existir em espaços diferentes. Tipo/nome/active da conta são devolvidos com ID; criação sempre começa ativa.

201 retorna exatamente account/revision. A revisão atual vem de GET `/api/v1/session`; listagem não adiciona campo fora do contrato. expectedRevision deve ser inteiro seguro positivo. Sob lock, revisão diferente retorna 409/REVISION_CONFLICT; chave repetida, 409/ACCOUNT_NAME_CONFLICT; limite seguro esgotado, 409/REVISION_EXHAUSTED. Nenhum desses casos cria conta ou avança revisão. Repetir POST com revisão antiga não é retry idempotente com retorno do resultado anterior.

## Listar contas

GET `/api/v1/accounts?limit=100&cursor=<UUID>` exige sessão, mas não CSRF por ser somente leitura. Se Origin for fornecida, deve ser permitida. limit padrão 100, de 1 a 200; não aceita decimal, expoente, repetição ou query extra. cursor é UUID da última conta devolvida quando nextCursor não é null, em ordem crescente por ID. UUID em caixa alta é canonicalizado para minúsculas.

200 retorna exatamente items/nextCursor; Account contém id/name/accountType/active. Inclui contas inativas existentes, preservando seu indicador. Cursor deve identificar conta do próprio espaço; estranho/inexistente recebe o mesmo 404/NOT_FOUND. Cursor malformado ou query inválida recebe 400/INVALID_QUERY. Listagem vazia retorna items vazio/nextCursor null. Leitura usa snapshot REPEATABLE READ READ ONLY, sem incrementar revisão. Não há snapshot congelado entre páginas: inserções posteriores podem exigir nova listagem.

## Garantias

Ator (userId/workspaceId/hash da sessão) é produzido pelo backend. Campos ownerId/workspaceId no cliente são rejeitados; não determinam acesso. Persistência também reautoriza o ator, inclusive antes da listagem/cursor.

Mutação autoriza, bloqueia espaço por proprietário, revalida sessão/usuário com relógio atual do banco após adquirir lock, compara revisão, insere conta e atualiza revisão uma vez no mesmo commit. Sessão revogada/expirada enquanto espera não pode escrever. Duas criações com mesma revisão geram um 201 e um 409, uma conta e um avanço. Falha após INSERT reverte conta e revisão juntas. Autenticação e leituras continuam sem mudar revisão.

Migração 003 relaxa somente teto de name_key interno: minúsculas de um nome válido de 200 caracteres podem expandir (ex.: İ produz i + ponto combinante). Nome público continua limitado, chave permanece não vazia e única; nenhum lower/collation implícita do banco é usado para gerar chave. Migrações 001/002 e contratos públicos permanecem intactos.

Configuração e privilégios anteriores mantidos; sem dependências novas. Erros/logs compartilham helpers HTTP de I02 e não expõem SQL, nome de conta, cookies ou credenciais. Sem alegação de exactly-once após falha de transporte: em dúvida, reler contas/revisão antes de enviar novo comando.

## Executar e verificar

Na instalação existente, sem apagar volume:

```sh
docker compose run --build --rm admin migrate
docker compose up -d --build api
```

Suíte completa no Windows: `& .\tools\test-docker.ps1`. Ela continua a usar projeto/volume novos, preserva dados existentes e executa PostgreSQL/HTTP reais, além de probes de conta/revisão após recriação.
