# Contratos vigentes após a harmonização

OpenAPI 3.1, info.version 0.5.0, para a primeira jornada. Não cobre automaticamente todos os endpoints complementares dos 14 RF. Summary contém categoryTotals obrigatório e a mesma definição é utilizada por Preview e Manifest. O manifesto vigente é mimir.manifest.v2, definido em manifesto-v2.schema.json.

A mudança para v2 identifica explicitamente o campo obrigatório novo. O caminho HTTP proposto continua /api/v1; ele não é a versão do esquema do manifesto. Os documentos v1 estão preservados na base privada anterior, fora deste repositório e não devem ser usados como testes positivos de v2. Não houve implantação ou migração de uma API real.

categoryTotals agrega somente transactions do mês e inclui transferências no fluxo. Normalizar categoria em NFC e trim na entrada, preservar diferenças de caixa, ordenar por bytes UTF-8 e manter grupo com saldo líquido zero. Leia docs/category-totals.md para regras completas e docs/verifier-acceptance.md para os aceites semânticos adicionais.

csv-import-v1.schema.json, importacao_exemplo.csv, importacao_normalizada.json e vetores-fingerprint.json foram preservados. vetores-totalizacao.json acrescenta quatro casos de domínio e não representa transações completas de manifesto. A conferência dos tipos não substitui somas, referências, pertença ao mês ou autorização.

Os schemas e o OpenAPI são contratos declarativos, não código da aplicação. O domínio .invalid identifica esquema local, não serviço publicado. O aplicativo e seu verificador CLI continuam pendentes de implementação.
