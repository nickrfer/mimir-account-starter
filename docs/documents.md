# Documentos - I05

Implementado somente POST /api/v1/transactions/{id}/documents, conforme OpenAPI 0.5.0. Requer sessão, Origin permitida e X-CSRF-Token; multipart/form-data com exatamente file (arquivo) e expectedRevision (texto decimal inteiro positivo seguro). Não definir Content-Type manualmente ao usar FormData: o cliente gera boundary. Campos repetidos/extras são rejeitados; revisão atual vem de GET /api/v1/session. Não há interface documental nesta etapa.

| Arquivo | Extensões | MIME declarado | Assinatura inicial |
| --- | --- | --- | --- |
| PDF | .pdf | application/pdf | %PDF- |
| PNG | .png | image/png | 89 50 4e 47 0d 0a 1a 0a |
| JPEG | .jpg/.jpeg | image/jpeg | ff d8 ff |

Extensões ignoram caixa. Arquivo não vazio, até **5242880 bytes (5 MiB)**. Corpo multipart inteiro limitado a arquivo + 16 KiB de envelope; campos/nome têm limites próprios. Parser FormData nativo do Node, após leitura limitada, sem gravar temporários. OriginalName normalizado NFC/trim, 1–255 caracteres, sem controles/separadores; parser nativo remove componentes de caminho. Nome é apenas metadado, nunca caminho. Bytes, tamanho e SHA-256 são calculados/conferidos no backend; não aceitos como campos adicionais do cliente.

Tipo/extensão não aceitos ou MIME divergente retornam 415; vazio/assinatura divergente/campos inválidos 422; multipart malformado 400; limite excedido 413. Trata-se de inspeção de assinatura, sem validação estrutural completa nem garantia de ausência de malware. Não há renderização de documentos ativos. Download futuro deverá exigir proprietário e attachment/nosniff, com nome de arquivo gerado pelo servidor.

Até duas admissões simultâneas por processo, incluindo leitura e espera no banco. Excesso retorna 429/Retry-After: 1. Não há fila ilimitada de arquivos na conexão pg; reserva é liberada inclusive em erro. Timeout HTTP existente: 10 s; SQL/espera de instrução: 1,5 s. Esses limites são locais à instância, sem promessa de rate limit distribuído ou desempenho universal.

## Persistência e revisão

Ator deriva da sessão; nenhuma escolha de espaço pelo cliente. READ COMMITTED, autorizar/lock do espaço por owner/reautorizar, transação própria FOR SHARE, estado ATIVA e comparação de revisão. Estrangeira/inexistente retornam o mesmo 404; excluída 409. Documento, vínculo, reconciliação e incremento único da revisão fazem commit/rollback juntos. Sessão é revalidada após possíveis esperas antes do avanço final. Qualquer erro reverte inclusive bytes e pendências.

Resposta 201 contém somente documentId, transactionId, sha256, sizeBytes e revision contratados. SHA-256 comprova integridade dos bytes, não assinatura nem validade contábil. Documento tem UUID novo por upload, mesmo se hash igual; repetição com revisão antiga é recusada sem novo documento. Repetir intencionalmente com revisão atual é um novo comando. Sem idempotência adicional presumida.

Conteúdo/metadados ficam em PostgreSQL bytea imutável: runtime só SELECT/INSERT em documents, sem UPDATE/DELETE/TRUNCATE. FKs compostas por espaço impedem vínculo cruzado. Não apagar bytes ao manipular vínculos em futuros incrementos. Migração 005 concede apenas UPDATE(status,justification,updated_at) em pending_items; tipo, descrição e identidade continuam protegidos. A migração 009 (I13) acrescenta UPDATE(description), restrito pelo trigger a DUVIDA_CADASTRADA.

## Reconciliação documental

Anexar resolve DOCUMENTO_AUSENTE existente no mesmo commit, preservando eventual justificativa como metadado. Não cria pendência documental em transferência/A_ESCLARECER. O vínculo é alteração material: outras pendências automáticas JUSTIFICADA voltam a PENDENTE e limpam justificativa. Classificação/reembolso ainda pendentes não são resolvidos por um arquivo. Dúvida manual mantém estado e texto.

## Comandos complementares (I15)

Contrato `packages/contracts/openapi-documentos.yaml` 0.1.0. `GET /documents?periodMonth=` lista documentos vinculados a lançamentos ativos do mês (até 1.000; acima disso 413 `DOCUMENT_LIST_LIMIT_EXCEEDED`). `GET /documents/{id}/content` devolve os bytes como `application/octet-stream`, `attachment` com nome `documento-<id>.<ext>` gerado pelo servidor, `nosniff`, CSP `sandbox` e `X-Content-SHA256`; vale para qualquer documento do espaço, com ou sem vínculo.

Vincular documento existente (`POST /transactions/{id}/document-links`), desvincular (`DELETE .../document-links/{documentId}`) e substituir (`POST .../document-replacements`, multipart com `replacedDocumentId`) seguem o protocolo de mutação: forma → existência no espaço (404) → revisão (409) → lançamento excluído (409) → estado do vínculo (409 `DOCUMENT_ALREADY_LINKED` / `DOCUMENT_NOT_LINKED`). Substituir cria documento novo com `supersedes_document_id`, troca só aquele vínculo e preserva o anterior e seus outros usos. Desvincular apaga só a linha de vínculo; bytes e metadados ficam. Nenhuma migração nova: o runtime já tinha `INSERT/DELETE` em `transaction_documents` e só `SELECT/INSERT` em `documents`.

Reconciliação no mesmo commit pela regra pura `reconcileAutomaticPending`, com vínculo documental como mudança material: vincular ou substituir resolve `DOCUMENTO_AUSENTE`; desvincular o último documento de receita ou despesa a reabre (ou cria) sem justificativa; outras pendências automáticas justificadas voltam a pendentes; dúvida manual não muda. O upload do I05 mantém o comportamento descrito acima. Entregas capturadas não mudam: pacotes leem `snapshot_documents` e o payload imutável.

## Executar e testar

Na raiz, preservando configuração/volumes existentes:

```sh
docker compose run --build --rm admin migrate
docker compose up -d --build api
docker compose run --rm admin migrate
```

A repetição retorna migrationsApplied vazio. Instalação nova segue README; não regenerar segredos para volume existente. No Windows: tools/test-docker.ps1. Linux: sh tools/test-docker.sh (execução integral em host Linux ainda não verificada). Testes usam configuração/projeto/volume novos e preservam volumes.

Suite cobre tipos/limites/multipart, bytes/hash SQL, autorização, revisão/concorrência, pendências, rollback por falhas após inserções, revogação durante bloqueios e grants reais. Probe na API do contêiner cria upload e verifica sessão/bytes/hash/vínculo/pendências/revisão após recriar banco/API.
