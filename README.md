# Mimir Account

PoC de organização financeira/documental mensal. **I01–I10 implementados (primeira jornada funcional completa)**: fundação Docker, provisionamento/sessões, contas PF/PJ, lançamentos manuais, upload documental imutável, prévia mensal consistente, captura imutável de snapshot, executor/empacotamento/publicação, verificador CLI independente e integração da interface web. IA permanece somente planejada. Resultados e limites de validação em [STATUS](docs/STATUS.md).

## Fluxo principal: Docker e Compose

Requisitos do host: Docker Engine com Compose moderno e shell nativo. Referência executada: Windows 11/Docker Desktop, Engine 29.9.2, Compose 5.6.1, contêineres Linux. Sem Node ou pnpm obrigatórios no host. Node 24.22.1/pnpm 12.16.1, dependências exatas e PostgreSQL 18.6 ficam nas imagens/lockfile existentes. Configuração de teste usa !override, disponível em Compose 2.24.4 ou superior.

Na raiz do repositório, em PowerShell ou shell Linux:

```sh
docker compose -p mimir-setup -f compose.setup.yaml run --rm setup
docker compose up -d --wait db
docker compose run --build --rm admin migrate
docker compose up -d --build api
```

**Nesta cópia local a configuração já existe: pule o primeiro comando.** Setup recusa sobrescrita; nunca regenere segredos para um volume existente. O bootstrap usa imagem Node fixada, não instala Node no host, dispensa .env prévio e não tem rede. Gera .env comum sem segredo, .env.runtime, .env.admin e .local/postgres-password. Arquivos permanecem ignorados. A localização da configuração gerada pelo bootstrap é relativa ao checkout, sem gravar /workspace como caminho do host.

Em Linux, antes do primeiro setup:

```sh
export LOCAL_UID="$(id -u)" LOCAL_GID="$(id -g)"
```

O usuário do setup deve ter permissão de escrita no checkout. No Windows Docker Desktop, montagem deve permitir acesso à pasta; valores padrão UID/GID 1000 funcionaram nesta execução. Modo 0600/0700 protege arquivos em Linux; Windows usa ACLs herdadas. Não execute setup como root para contornar permissão em Linux. Configuração gerada antes desta continuação continua válida; não é necessário substituir arquivos existentes.

Abra [aplicação local](http://127.0.0.1:3000). API serve SPA compilada no contêiner. GET/HEAD /health responde 200 se processo está vivo; /ready responde 200 com banco/esquema acessível e 503 se indisponível. Respostas contêm apenas status ok/unavailable. Rotas implementadas e limitações estão descritas abaixo.

## Provisionamento e sessão — I02

Atualizar instalação existente sem apagar volume: executar `docker compose run --build --rm admin migrate` e `docker compose up -d --build api`. Migração 002 restringe atualizações de sessões; 001 não foi alterada.

Para criar proprietário, seguir [provisionamento por stdin e autenticação](docs/authentication.md). Tarefa temporária `admin create-owner` recebe JSON somente por stdin, cria usuário/espaço atomicamente e retorna apenas IDs. O procedimento PowerShell usa Read-Host -AsSecureString, sem senha em argumentos ou arquivo. Nenhum usuário pessoal/padrão foi criado automaticamente.

Implementados POST/GET/DELETE `/api/v1/session`, conforme contrato: Argon2id, cookie HttpOnly/SameSite=Lax, 8 h absolutas, token armazenado apenas como SHA-256, CSRF, rotação/revogação e limite de login. Login requer Origin exata e JSON; logout requer também X-CSRF-Token. HTTP sem Secure é exceção explícita apenas local; HTTPS mantém Secure. Sem UI de login nesta etapa.

Origens locais padrão: localhost/127.0.0.1 nas portas 3000 e 5173. Ao mudar porta, ajustar MIMIR_ALLOWED_ORIGINS em .env; MIMIR_ALLOW_LOCAL_HTTP controla exceção. No Node direto, usar APP_ORIGINS/ALLOW_LOCAL_HTTP em .env.runtime. Contadores de login em memória reiniciam com API; sessões permanecem no banco. [Evidências I02](docs/evidence/I02.md).

## Contas PF/PJ e revisão — I03

Implementados GET/POST `/api/v1/accounts`, com sessão própria; criação exige Origin/CSRF e expectedRevision. Nome NFC/trim, chave única em minúsculas por espaço, paginação por UUID (100 padrão, 200 máximo). Conta e incremento de revisão fazem commit/rollback juntos. Revisão desatualizada, duplicata ou limite seguro retornam 409 sem alterar dados; sessão é revalidada depois de obter lock.

Para atualizar instalação existente, repetir migração e build API dos comandos acima. Migração 003 ajusta somente chave interna derivada para expansão Unicode; 001/002 e contratos preservados. [Funcionamento de contas](docs/accounts.md) e [evidências I03](docs/evidence/I03.md). Sem edição/inativação de contas ou novas telas nesta etapa.

Banco em rede interna, sem porta publicada. API escuta 0.0.0.0 internamente e publica somente 127.0.0.1:3000. Porta pode ser alterada por MIMIR_HTTP_PORT em .env. Volume pgdata monta /var/lib/postgresql, conforme imagem PostgreSQL 18.

Administração é tarefa temporária. Repetir migrate não reaplica SQL; checksum alterado aborta. --build assegura que novas migrações entrem na imagem administrativa.

## Lançamentos manuais e pendências iniciais — I04

Implementado POST `/api/v1/transactions`, com sessão, Origin/CSRF, conta própria ativa e expectedRevision. Receita/entrada, despesa/saída, transferências e registros a esclarecer seguem o contrato; marca empresarial exige despesa/saída em conta PF. Receita PF é permitida. Centavos inteiros e datas civis são validados; mês e procedência MANUAL são definidos pelo servidor.

Período, lançamento, pendências iniciais e um avanço de revisão fazem commit/rollback juntos. A sessão é revalidada após esperas de bloqueio. JSON desta rota aceita até 32 KiB para campos Unicode máximos; rotas anteriores continuam em 8 KiB. Migração 004 acrescenta pending_items, com FK composta e somente SELECT/INSERT para runtime. Atualização usa os mesmos comandos migrate/build acima, preservando volumes.

[Regras e limites](docs/transactions.md) e [evidências I04](docs/evidence/I04.md). Sem edição de lançamentos, telas ou gestão completa de pendências. I05 reconcilia as pendências ao anexar documentos; I06 permite leitura mensal. Reembolso e IA não foram implementados.

## Upload documental — I05

Implementado POST `/api/v1/transactions/{id}/documents`: multipart com exatamente file e expectedRevision, sessão/Origin/CSRF e movimentação própria ativa. PDF/PNG/JPEG até 5 MiB, extensão/MIME/assinatura conferidos, SHA-256 calculado no servidor. Documento imutável, vínculo, reconciliação de pendências e revisão única persistem juntos; erro reverte tudo.

Migração 005 concede somente colunas de reconciliação em pending_items; documentos continuam sem UPDATE/DELETE/TRUNCATE. Use os mesmos comandos migrate/build já apresentados. Até duas admissões simultâneas por processo, corpo limitado a 5 MiB + 16 KiB de envelope, sem temporários de upload. Excesso simultâneo retorna 429. [Uso/regras/limitações](docs/documents.md) e [evidências I05](docs/evidence/I05.md).

Sem download, reutilização/substituição/desvínculo ou telas. Verificação de assinatura não comprova ausência de malware.

## Prévia mensal — I06

GET `/api/v1/periods/2026-11/preview`, com cookie de sessão própria; sem CSRF por ser leitura. Origin, quando enviada, deve ser permitida; mês aceita 1900–9999 e 01–12, sem query adicional. Dados, autorização e revisão pertencem à mesma transação PostgreSQL REPEATABLE READ READ ONLY. Não cria período, reconcilia pendência nem incrementa revisão. Mês sem dados retorna 200 com listas vazias e totais zero.

Movimentações ativas principais, contas (inclusive histórico de conta inativa), documentos e pendências compõem a prévia. Fluxos por conta/categoria incluem transferências; receita PF não soma receita empresarial. Pendências resolvidas aparecem sem entrar nas contagens pendente/justificada. Ordenação por data/ID, tipo/ID e categoria por bytes UTF-8. Excesso de 1.000 registros, 1.000 documentos únicos, 10.000 associações ou 100 MiB únicos retorna 413 sem truncar.

Não existem vínculos de reembolso implementados: `contextTransactions` e `reimbursementLinks` vazios, liquidação zero e despesa PF empresarial pendente. Não se infere vínculo por coincidência de valor/data. [Escopo e decisões](docs/implementation/I06.md), [evidências](docs/evidence/I06.md).

## Captura, executor e publicação — I07 e I08

- `POST /api/v1/deliveries`: exige `Idempotency-Key` (16–128 ASCII), `periodMonth`, `expectedRevision` e `rectificationReason`. Consulta a chave antes da revisão sob bloqueio do espaço; repetição idêntica retorna a operação existente (`202` não terminal, `200` terminal) e payload divergente retorna `409 IDEMPOTENCY_PAYLOAD_MISMATCH`. Captura o snapshot completo (`mimir.snapshot.v1`), referências documentais e operação `EM_FILA` sem incrementar `revision`.
- `GET /api/v1/operations/{id}` e `GET /api/v1/periods/{month}/deliveries`: consultam estado e histórico paginado sem expor tokens internos de posse.
- `DeliveryExecutor` (processo da API): polling a cada 2 s, 1 trabalho por vez, lease de 30 s renovado a cada 5 s, token monotônico (`fencing_token`), até 3 tentativas (retries em 2 s e 5 s; falha terminal ou varredura de lease expirado na 3ª tentativa). Empacota `resumo.html`, `movimentacoes.csv`, `manifesto.json` (`mimir.manifest.v2`) e `anexos/{documentId}.{ext}` exclusivamente a partir do snapshot imutável, em `/tmp/mimir-delivery` (`tmpfs`), e publica em `delivery_packages` + `PRONTA` no mesmo commit.
- `GET /api/v1/deliveries/{snapshotId}/package` e `GET /api/v1/deliveries/{snapshotId}/manifest`: retornam `409 DELIVERY_NOT_READY` enquanto não pronta e servem os bytes exatos publicados quando `PRONTA`. Detalhes em [I07](docs/implementation/I07.md), [I08](docs/implementation/I08.md) e [evidência I08](docs/evidence/I08.md).

## Verificador CLI independente — I09

- `node packages/verifier/dist/index.js <diretorio-extraido> <manifesto-externo.json>` (ou `--package-dir` / `--reference-manifest`): valida offline pacotes extraídos contra um manifesto de referência externo (`mimir.manifest.v2`).
- Retorna código `0` para pacote íntegro e válido, `1` para qualquer violação de integridade/schema/relações/cálculos (recalculando `cashFlowByAccount`, `categoryTotals`, `businessRevenueTotalCents`, `businessExpenseTotalCents`, `reimbursementsSettledInPeriodCents`, `pendingCount`, `justifiedCount`, tamanhos/SHA-256, ausência de arquivos extras/faltantes/symlinks, `movimentacoes.csv` v1 e ausência de conteúdo ativo em `resumo.html`) e `2` para argumentos inválidos ou autorreferência ao `manifesto.json` interno.
- Executado também no contêiner isolado `verifier` (`network_mode: none`, `read_only: true`) sobre o pacote real gerado pela API/Executor na etapa `verifier-package` da suíte Docker. Detalhes em [I09](docs/implementation/I09.md) e [evidência I09](docs/evidence/I09.md).

## Interface web da primeira jornada — I10

- SPA React 19 + TypeScript (`apps/web`) servida pela API em `/` e via Vite em `127.0.0.1:5173` (perfil `dev`), respeitando `Content-Security-Policy: default-src 'self'`.
- Cobre toda a primeira jornada funcional: login/logout (`POST/GET/DELETE /api/v1/session`), contas PF/PJ (`GET/POST /api/v1/accounts`), lançamentos manuais com conversão determinística para centavos (`POST /api/v1/transactions`), upload documental imutável (`POST /api/v1/transactions/{id}/documents`), prévia mensal consistente (`GET /api/v1/periods/{month}/preview`), captura idempotente (`POST /api/v1/deliveries`), polling da operação (`GET /api/v1/operations/{id}`), histórico (`GET /api/v1/periods/{month}/deliveries`), downloads de pacote ZIP e manifesto v2 (`/package` e `/manifest`) e comando pronto para o verificador CLI (`@mimir/verifier`). Detalhes em [I10](docs/implementation/I10.md) e [evidência I10](docs/evidence/I10.md).

## Logs e encerramento

```sh
docker compose logs --tail 100 -f api db
docker compose ps
docker compose down
```

down preserva dados. **Não use down -v para reiniciar.** Não faça docker compose config sem filtros para compartilhar diagnóstico: configuração expandida contém segredos. Prefira config --services e evidências booleanas existentes.

## Testes sem Node no host

Windows PowerShell (nativo; PowerShell 7 também funciona):

```powershell
& .\tools\test-docker.ps1
```

Linux/POSIX sh:

```sh
sh tools/test-docker.sh
```

Scripts usam Docker CLI do host, nunca Docker/socket dentro do contêiner. Criam projeto/configuração/volume novos mimir-docker-*, usam portas aleatórias no loopback e não alteram projeto de referência. Shell Linux define UID/GID automaticamente.

Cada execução compila imagens e roda **todos os testes unitários e PostgreSQL dentro do contêiner**. Confere instalação limpa, migração repetida/checksum/rollback, privilégios, FKs, BIGINT/DATE, SPA/health/readiness, ambiente real da API sem credenciais/arquivos administrativos, banco parado, recriação de db e API com dois documentos sintéticos preservados, Vite/proxy e mensagem HMR após alterar módulo temporário. Confere também a verificação do pacote real publicado pelo contêiner `verifier` sem rede (`verifier-package`).

Ao terminar, encerra somente serviços próprios; **volumes são preservados**, inclusive em falhas. Log detalhado fica em .local/<projeto>/run.log e resumo sanitizado em docs/evidence/docker-*.json. Não compartilhe configuração ou log local sem revisão. Volumes antigos podem ser removidos manualmente após inspeção; suíte não os remove.

Somente testes unitários, sem iniciar banco:

```sh
docker compose run --build --rm --no-deps --entrypoint node admin tools/checks/tests.mjs unit
```

Resultado atual: testes unitários, PostgreSQL/HTTP e probes na API real passaram em Docker Windows; contagens/resultados em [STATUS](docs/STATUS.md) e [evidência I09](docs/evidence/I09.md). Sessão mantém expiração absoluta e conta/lançamento/documento/snapshot/pacote permanecem após recriar API/banco. Execução integral POSIX em host Linux ainda não realizada e não bloqueia Windows. Evidências anteriores preservadas.

## Desenvolvimento com Vite em contêiner

```sh
docker compose --profile dev up -d --build dev-web
docker compose --profile dev logs --tail 100 -f dev-web
```

Abra [Vite local](http://127.0.0.1:5173). Perfil dev mantém API e banco, publica Vite só no loopback e encaminha /api, /health e /ready para API. Vite não recebe arquivo de ambiente administrativo/runtime. Fontes src, index.html e vite.config.ts são montadas somente para leitura; dependências Linux ficam na imagem, sem compartilhar node_modules do host. Cache fica em /tmp. Vite inicia como usuário node, usando carregador de configuração nativo do Node.

Polling de arquivos habilitado por padrão para alterações via Windows/Docker Desktop. Em Linux com eventos nativos confiáveis, MIMIR_WATCH_POLLING=false em .env reduz uso de CPU. MIMIR_VITE_PORT altera publicação padrão 5173. Mudança em dependências/lockfile exige novo build; mudança de configuração exige reiniciar dev-web. React Fast Refresh não foi adicionado; Vite pode recarregar página ao editar módulos sem aceitação HMR.

Para encerrar também perfil dev, preservando volumes:

```sh
docker compose --profile dev down
```

## CLI como tarefa temporária

```sh
docker compose run --build --rm --no-deps -v /caminho/pacote:/pkg:ro -v /caminho/referencia.manifesto.json:/ref.json:ro verifier /pkg /ref.json
```

Sem argumentos termina com **código 2** (erro de uso); com diretório extraído e manifesto externo confiável retorna **0** quando íntegro ou **1** em caso de adulteração/inconsistência. Serviço não tem rede nem credenciais; dispensa Node no host.

## Alternativa com Node no host

Node 24.22.1 LTS e pnpm 12.16.1, se já instalados:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:integration
```

Último comando delega ao mesmo script Docker do host; não mantém segunda implementação da suíte. pnpm setup continua alternativa, mas bootstrap Docker é preferido. pnpm start usa allowlist de .env.runtime; execução Node direta exige URL de banco alcançável pelo host, diferente do DNS interno db. Banco não é publicado por padrão. No Windows desta sessão npm precisou de NODE_OPTIONS=--use-system-ca, mantendo verificação TLS. Nenhuma mudança global de runtime foi realizada.

## Segurança, escopo e documentação

mimir_migrator possui schema/tabelas. mimir_runtime não possui tabelas nem privilégios administrativos; sem DDL/CREATE/TEMP/TRUNCATE, associação ao migrador ou INSERT em users/workspaces. Documents, snapshots, snapshot_documents, idempotency_keys e delivery_packages permitem SELECT/INSERT apenas; delivery_operations permite UPDATE somente nas colunas de estado/posse/tentativa, guardado por triggers. FKs compostas/RESTRICT protegem integridade; API não lê .env.admin e não recebe credenciais administrativas. Configurações preenchidas não entram no build.

Esquema: users, workspaces, sessions, accounts, periods, transactions, documents, transaction_documents, pending_items, delivery_snapshots, snapshot_documents, delivery_operations, idempotency_keys, delivery_packages. Fixtures são sintéticas; nenhum seed público. Proteção de privilégios não resiste a administrador que altere esquema/permissões. Rotação de segredos e backup/restauração não foram automatizados. C01–C06 continuam não executados.

[Assistente de preparação mensal com IA](docs/optional-monthly-assistant.md): **somente proposta**, depois da jornada funcional, desabilitado por padrão. Sem SDK/chave/tela/configuração antecipada; sistema permanece independente de IA.

Consulte [STATUS](docs/STATUS.md), [DECISIONS](docs/DECISIONS.md), [DEPENDENCIES](docs/DEPENDENCIES.md) e [START_HERE](docs/START_HERE.md). Contratos vigentes preservados: manifesto v2, CSV v1 e OpenAPI 0.5.0. Licença própria MIT. Sem publicação ou deploy.
