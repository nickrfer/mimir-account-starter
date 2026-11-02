# Contratos vigentes após a harmonização

OpenAPI 3.1, info.version 0.5.0, para a primeira jornada. Não cobre automaticamente todos os endpoints complementares dos 14 RF. Summary contém categoryTotals obrigatório e a mesma definição é utilizada por Preview e Manifest. O manifesto vigente é mimir.manifest.v2, definido em manifesto-v2.schema.json.

A mudança para v2 identifica explicitamente o campo obrigatório novo. O caminho HTTP proposto continua /api/v1; ele não é a versão do esquema do manifesto. Os documentos v1 estão preservados na base privada anterior, fora deste repositório e não devem ser usados como testes positivos de v2. Não houve implantação ou migração de uma API real.

categoryTotals agrega somente transactions do mês e inclui transferências no fluxo. Normalizar categoria em NFC e trim na entrada, preservar diferenças de caixa, ordenar por bytes UTF-8 e manter grupo com saldo líquido zero. Leia docs/category-totals.md para regras completas e docs/verifier-acceptance.md para os aceites semânticos adicionais.

openapi-reembolsos.yaml (OpenAPI 3.1, info.version 0.1.0) é contrato complementar do RF-07, implementado no I11: criar, listar, consultar candidatos e desfazer vínculos de reembolso. Não altera a OpenAPI da jornada nem o manifesto v2; os campos de vínculo reutilizam os nomes do schema Reimbursement.

openapi-lancamentos.yaml (OpenAPI 3.1, info.version 0.1.0) é contrato complementar do RF-04, implementado no I12: consultar, listar, corrigir e excluir logicamente lançamentos. A criação continua em openapi-jornada-inicial.yaml.

csv-import-v1.schema.json, importacao_exemplo.csv, importacao_normalizada.json e vetores-fingerprint.json foram preservados. vetores-totalizacao.json acrescenta quatro casos de domínio e não representa transações completas de manifesto. A conferência dos tipos não substitui somas, referências, pertença ao mês ou autorização.

Os schemas e o OpenAPI são contratos declarativos, não código da aplicação. O domínio .invalid identifica esquema local, não serviço publicado. O aplicativo e seu verificador CLI continuam pendentes de implementação.

openapi-pendencias.yaml (OpenAPI 3.1, info.version 0.1.0) é contrato complementar do RF-08, implementado no I13: listar pendências do mês, registrar dúvida manual e justificar, resolver, reabrir ou editar pendências. Não altera openapi-jornada-inicial.yaml, openapi-reembolsos.yaml nem openapi-lancamentos.yaml; manifesto v2 e fixtures permanecem com os mesmos bytes.

openapi-documentos.yaml (OpenAPI 3.1, info.version 0.1.0) é contrato complementar do RF-06, implementado no I15: listar documentos do mês, baixar conteúdo, vincular documento existente, desvincular e substituir documento. Não altera openapi-jornada-inicial.yaml (upload), openapi-lancamentos.yaml, openapi-reembolsos.yaml nem openapi-pendencias.yaml; manifesto v2 e fixtures permanecem com os mesmos bytes.
