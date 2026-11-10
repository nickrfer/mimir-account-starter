# Lançamentos manuais - I04

POST /api/v1/transactions implementa TransactionInput/TransactionMutation do OpenAPI 0.5.0 sem alterar contratos. Requer sessão, Origin permitida, X-CSRF-Token e JSON de até 32 KiB. GET/edição/exclusão e telas ainda não existem. Revisão atual é obtida por GET /api/v1/session.

Todos os dez campos são obrigatórios: accountId, occurredOn, direction, amountCents, description, category, classification, isPfBusinessExpense, explanation e expectedRevision. Campos extras e query são rejeitados, inclusive espaço, mês e procedência enviados pelo cliente. Conta própria ativa; estrangeira/inexistente retorna mesmo 404, inativa 409. UUID, data civil real entre 1900 e 9999, centavos inteiros positivos até 99999999999, revisão inteira segura positiva. Datas e centavos não passam por fuso ou ponto flutuante financeiro.

RECEITA exige ENTRADA; DESPESA exige SAIDA; TRANSFERENCIA/A_ESCLARECER aceitam ambas. Marca PF empresarial exige conta PF, DESPESA e SAIDA. Receita PF é permitida; não se transforma em receita empresarial por ser entrada. Totais ainda não são calculados.

Descrição (1–500), categoria (1–100) e explicação (0–2000) usam NFC, CRLF para LF e trim, com limites antes/depois da normalização e rejeição de NUL. JSON maior que 32 KiB retorna 413; sessões/contas continuam em 8 KiB. Servidor deriva mês YYYY-MM e gera UUID/procedência MANUAL; externalId é o ID do lançamento. Não cria origem de importação artificial. Lançamentos importados por CSV (I16, `docs/http-api.md` e `packages/contracts/openapi-importacao.yaml`) têm procedência `CSV`, fonte e `externalId` da linha, origem imutável em `import_origins` e conta que não pode ser trocada; a procedência de qualquer lançamento é protegida por trigger (migrações 010 e 011).

## Atomicidade e segurança

Adaptador inicia READ COMMITTED, autoriza ator de sessão, bloqueia espaço pelo proprietário e reautoriza com relógio do banco. Conta própria é consultada FOR SHARE, estabilizando tipo/nome/atividade durante o commit. Depois das regras, compara expectedRevision. Cria período se necessário (sem sobrescrever notas existentes), lançamento e pendências, revalida sessão após possíveis esperas e avança revisão uma vez. Qualquer falha reverte tudo. Concorrência com mesma revisão permite um comando e recusa o outro com 409; repetição com revisão antiga também não escreve. Não há idempotência adicional para este POST no contrato vigente.

Resposta 201 contém somente transaction e revision contratados. documentIds começa vazio; reimbursementStatus é PENDENTE_REEMBOLSO na despesa PF empresarial, NAO_APLICAVEL nos demais. Essas informações não representam anexos/reembolsos já executados.

## Pendências iniciais

Migração 004 acrescenta pending_items com FK composta por espaço/transação, unicidade transação/tipo e constraints de tipo/estado/justificativa. Runtime recebe somente SELECT/INSERT, sem UPDATE/DELETE/TRUNCATE. Migrações 001–003 permanecem intactas.

| Condição na criação | Pendência |
| --- | --- |
| RECEITA ou DESPESA, sem documento nesta etapa | DOCUMENTO_AUSENTE |
| A_ESCLARECER | CLASSIFICACAO_A_ESCLARECER |
| Despesa PF empresarial | REEMBOLSO_PF_PENDENTE, além da documental |

Estado inicial PENDENTE, justificativa vazia. Explicação do lançamento não justifica automaticamente pendência. Não implementados: dúvida manual, comandos de justificativa/resolução/reabertura ou vínculo de reembolso. Anexos foram acrescentados posteriormente em I05. I05 reconcilia DOCUMENTO_AUSENTE junto ao vínculo documental; ver [documentos](documents.md). Não se declara o ciclo completo de pendências concluído.

## Executar e verificar

Na raiz: docker compose run --build --rm admin migrate; depois docker compose up -d --build api. Repetir migrate deve retornar lista vazia. Não apagar volumes nem regenerar segredos existentes. Para suíte isolada, executar tools/test-docker.ps1 no Windows ou sh tools/test-docker.sh em Linux (execução integral em host Linux ainda não verificada).

Testes usam PostgreSQL real e fixtures sintéticas. Cobrem contrato, PF/PJ, limites Unicode, mês/procedência, sessão/Origin/CSRF, conta estrangeira/inativa, concorrência, rollback pós-inserções, revogação/expiração após locks, constraints e privilégios. Probes da API em contêiner conferem lançamento/pendências/revisão e sessão após recriar db/API sem apagar volume. Resultados efetivamente executados em [evidência I04](evidence/I04.md).
