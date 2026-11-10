# Ponto de partida técnico

O Mimir-Account é um projeto novo de organização financeira/documental e preparação mensal de pacotes para contador externo. I01–I10 (primeira jornada funcional completa) executam em Docker: interface web React/TS, API operacional, PostgreSQL persistente, provisionamento/sessões, contas PF/PJ, criação de lançamentos manuais, upload documental imutável, pendências/revisão transacionais, prévia mensal consistente, captura imutável de snapshot, executor/empacotamento/publicação de entregas e verificador CLI independente; especificações e contratos orientam os incrementos complementares seguintes.

O problema arquitetural é preservar uma entrega coerente quando o acervo muda, comandos são repetidos e a geração é interrompida. A primeira jornada será: usuário provisionado, login, conta, movimentação manual, documento, prévia, captura, geração, acompanhamento, download e verificação. Transferência do ZIP ao contador ocorre fora do sistema.

## Decisões vigentes

Frontend React/TS/Vite; API modular Node/TS; PostgreSQL 18 incluindo bytea; uma instância inicial, com executor interno. Portas/adaptadores separam regras e SQL. O modelo usa documentos e snapshots imutáveis, revisão do acervo e versões de entrega distintas. A distribuição está na comunicação navegador/API/banco, não em microsserviços.

Manifesto vigente mimir.manifest.v2, OpenAPI 0.5.0 da primeira jornada, CSV de importação v1. categoryTotals está harmonizado; não reabrir essa pendência. Endpoints complementares ainda são descritos textualmente e deverão receber contrato detalhado antes de serem implementados.

Autenticação em [authentication.md](authentication.md) e resultados da avaliação formal em [avaliacao/resultados](avaliacao/resultados/README.md). Docker/Compose no Windows basta para continuar; host Linux é verificação complementar de portabilidade. A [extensão opcional de revisão mensal com IA](optional-monthly-assistant.md) está apenas planejada para depois da jornada funcional, desabilitada por padrão e sem novas dependências nesta fase.

Contas/revisão: [accounts](accounts.md). Somente GET/POST; demais comandos exigem incremento/contrato correspondente.

## Fontes dentro deste repositório

| Documento | Conteúdo |
| --- | --- |
| domain.md | Valores, datas, classificação, CSV, reembolso e pendências |
| data-model.md | Entidades, FKs por espaço, índices e fechamento do snapshot |
| http-api.md | Sessões, autorização, endpoints e erros |
| protocols.md | Revisão, captura, idempotência, executor e persistência |
| export-format.md | Pacote estático, manifesto e limites |
| category-totals.md | Regra vigente de agregação por categoria |
| verifier-acceptance.md | Critérios adicionais do CLI para o RF-09 |
| requirements.md | RF/RNF e condições de avaliação planejadas |
| adr/DECISIONS.md | Alternativas e compromissos arquiteturais já definidos |

Os documentos técnicos foram consolidados de uma base documental anterior. Leitura de normas e escrita acadêmica ficam fora deste repositório público. Se houver conflito técnico, category-totals define as invariantes vigentes; schemas/OpenAPI definem a forma pública; a regra de negócio exige as verificações semânticas. Registre o conflito e faça a correção mínima coerente, sem apagar testes ou ampliar o escopo.

Lançamentos: [transactions](transactions.md) (I04). Criação de lançamentos; upload I05 reconcilia pendências documentais. I06 acrescenta prévia consistente sem escrita; I07 captura o snapshot mensal com idempotência, I08 executa, empacota e publica as entregas, I09 implementa o verificador CLI independente e I10 integra a interface web da primeira jornada. I11 acrescenta reembolsos integrais PF→PJ (RF-07), com contrato complementar `packages/contracts/openapi-reembolsos.yaml`. I12 acrescenta correção e exclusão lógica de lançamentos (RF-04), com contrato `packages/contracts/openapi-lancamentos.yaml`. I13 acrescenta o ciclo de pendências (RF-08), com contrato `packages/contracts/openapi-pendencias.yaml`. I14 torna o resumo da entrega legível para o contador (RF-12/RNF-05). I15 completa os documentos (RF-06): listar, baixar, vincular existente, desvincular e substituir, com contrato `packages/contracts/openapi-documentos.yaml`. I16 acrescenta a importação de CSV (RF-03), com contrato `packages/contracts/openapi-importacao.yaml`. IA continua somente planejada.

Documentos: [regras/limites](documents.md) (I05). Somente upload e vínculo atômicos; sem download/comandos complementares ou UI.
