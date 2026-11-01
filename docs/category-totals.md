# Totais por categoria

Regra vigente do RF-09; implementações devem seguir também os contratos em packages/contracts.

## Contrato comum de totalização

Summary passa a conter categoryTotals obrigatório na prévia, no snapshot capturado e no manifesto. Cada item tem category, inflowCents, outflowCents e netCents. Todos os valores são inteiros em centavos; entradas e saídas são não negativas, enquanto o saldo líquido pode ser negativo. netCents = inflowCents - outflowCents.

A fonte é exclusivamente transactions: movimentações ativas do mês, já selecionadas e validadas no domínio. contextTransactions nunca participa da soma. TRANSFERENCIA e A_ESCLARECER integram o fluxo por categoria de acordo com sua direção; esse indicador não é o resumo de receitas/despesas empresariais e não exclui automaticamente contas PF. Uma receita PF aparece no fluxo de sua categoria, mas continua fora de businessRevenueTotalCents.

Antes da persistência, a categoria recebe normalização Unicode NFC e remoção de espaços periféricos. Categoria vazia é inválida. Diferenças de maiúsculas/minúsculas continuam distintas: SERVICOS e servicos não são combinadas silenciosamente. Não se cria um cadastro de categorias ou classificação fiscal neste ajuste.

Na prévia e no manifesto, categoryOriginal já deve conter o valor normalizado. Um manifesto que não cumpra isso deve ser rejeitado pela validação semântica; o verificador não corrige o arquivo recebido. Os vetores de normalização exercitam a etapa de entrada, antes dessa persistência.

O agrupamento considera a categoria em todas as contas do proprietário. Há exatamente uma linha por categoria presente nos registros principais. Categorias ausentes não recebem linhas zeradas. Categorias presentes cujo saldo líquido seja zero permanecem na lista, com suas entradas e saídas preservadas. A lista é ordenada lexicograficamente pelos bytes UTF-8 da categoria normalizada, sem depender de locale/collation do ambiente. Prévia vazia devolve categoryTotals vazio; captura vazia continua proibida.

O JSON Schema valida campos, tipos e limites locais. Unicidade da categoria, ordenação, cobertura, somas e exclusão de contexto são invariantes semânticas adicionais. uniqueItems não substituiria esses controles, porque objetos com a mesma categoria e valores diferentes ainda poderiam ser distintos para o JSON Schema.

## Regras de reconciliação

Somar inflowCents de todas as categorias deve produzir a soma das entradas de transactions e dos totais por conta. A mesma igualdade vale para outflowCents e netCents. A comparação deve usar inteiros seguros e limites já definidos para a captura. Não somar novamente os totais por conta aos totais por categoria: são duas visões sobre os mesmos registros.

O resumo empresarial permanece independente: receitas somente ENTRADA/RECEITA PJ; despesas conforme a regra PJ ou PF empresarial; reembolso PJ como transferência e liquidação, sem nova despesa. Pendências mantêm as contagens anteriores. Não há alteração na regra de competência, apuração fiscal ou dedutibilidade.

O snapshot guarda Summary e todos os dados necessários para recalculá-lo. A geração usa apenas o conteúdo capturado. O HTML exibe os totais por conta e categoria do mesmo Summary. O CSV continua sendo de movimentações, incluindo categoria por linha; não recebe linhas de subtotais que poderiam ser confundidas com movimentações. O manifesto contém o agregado. O futuro CLI recalcula os valores a partir dos registros capturados e compara com Summary.

## Versionamento e compatibilidade

O arquivo vigente é manifesto-v2.schema.json, com schemaVersion = mimir.manifest.v2. categoryTotals tornou-se obrigatório: por isso o novo esquema foi identificado separadamente, preservando v1 e suas fixtures na base privada de documentação, fora deste repositório. O identificador do esquema não representa versão de entrega: outubro v1 e outubro v2 continuam sendo números de entrega de um conjunto sintético, ambos podendo usar manifesto v2.

O OpenAPI da primeira jornada tem info.version = 0.5.0, sem trocar o prefixo HTTP /api/v1. São versões de artefatos de contrato anteriores à implementação; não existe API implantada sendo migrada. Preview.summary e Manifest.summary apontam à mesma definição de Summary no OpenAPI, equivalente à do JSON Schema externo. O contrato CSV de entrada continua v1 e seus bytes foram preservados.

O futuro verificador desta primeira implementação deve aceitar explicitamente manifesto v2 e diagnosticar versão não suportada para v1. Compatibilidade com v1 não está implementada nem é presumida. Os exemplos antigos continuam utilizáveis como histórico documental, mas não são os testes positivos do novo contrato. Não se deve apenas trocar a string de versão de uma entrega antiga ou adicionar valores presumidos a um artefato publicado.

## Exemplos e oráculos atualizados

Foram criadas novas fixtures, fora da aplicação, com novos workspaceId, snapshotId e operationId em relação aos exemplos históricos. Não houve alteração retroativa de entrega armazenada no sistema, que ainda não foi construído. Os documentos PNG preservam os mesmos bytes; as categorias e saídas textuais foram atualizadas.

| Exemplo | Categoria | Entradas | Saídas | Saldo líquido |
| --- | --- | --- | --- | --- |
| Outubro v1 e v2 | INFRAESTRUTURA | 0 | 10.000 | -10.000 |
| Outubro v1 e v2 | SERVICOS | 200.000 | 0 | 200.000 |
| Outubro v1 e v2 | TARIFAS | 0 | 500 | -500 |
| Novembro v1 | TRANSFERENCIAS | 10.000 | 10.000 | 0 |

Valores em centavos. Em novembro, a despesa PF de outubro aparece somente como contexto: não cria INFRAESTRUTURA nos totais de novembro. Em outubro v2, as transferências de novembro são contexto e não alteram os totais de outubro. Essa igualdade entre outubro v1 e v2 é um controle explícito contra dupla contagem.

CSV e HTML vigentes refletem as mesmas categorias. Tamanhos e hashes dos arquivos alterados, manifestos externos e ZIPs foram recalculados. Os oráculos de categoria foram escritos com valores esperados independentes; não se limitou a comparar o arquivo com outra serialização da própria saída.

