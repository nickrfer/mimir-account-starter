# Critérios de aceite do verificador para o RF-09

Estado: especificados; futura implementação do CLI pendente. A ferramenta auxiliar de autoria utilizada para conferir as fixtures deste pacote não é o CLI do produto.

## Entrada e versão

Ler o diretório extraído e uma cópia externa confiável do manifesto. Comparar bytes, validar schemaVersion mimir.manifest.v2 e aplicar manifesto-v2.schema.json. Versão v1 deve produzir diagnóstico de versão não suportada; não estimar campos ausentes. Preservar os demais controles de arquivos, relações, hashes e caminhos de export-format.md.

## Controles semânticos de categoryTotals

1. Validar que cada categoryOriginal de transactions está em NFC, sem espaços periféricos, não vazia e dentro dos limites do esquema.
2. Obter o conjunto de categorias exclusivamente de transactions do mês; não usar contextTransactions, categorias atuais do banco ou arquivos externos.
3. Exigir exatamente uma linha por categoria desse conjunto, sem categorias extras, ausentes ou repetidas. Lista vazia só é coerente com conjunto principal vazio, permitido para prévia, não para entrega capturada.
4. Exigir ordem crescente por bytes UTF-8, independente de locale.
5. Recalcular as entradas e saídas de cada grupo por direction e amountCents, incluindo transferências e itens a esclarecer. Não aplicar aqui filtros de receita empresarial ou de conta PJ.
6. Comparar os dois valores calculados com inflowCents e outflowCents. Verificar também netCents = inflowCents - outflowCents; uma linha com saldo zero não pode ser descartada.
7. Reconciliar as somas de todas as categorias com os registros principais e com cashFlowByAccount, conferindo que o conjunto de contas também cobre os registros sem duplicatas ou omissões.
8. Recalcular separadamente businessRevenueTotalCents, businessExpenseTotalCents, reimbursementsSettledInPeriodCents e contagens de pendências pelas regras já existentes.
9. Não modificar os dados para fazê-los passar. Registrar diagnóstico com campo/categoria afetada, sem divulgar conteúdo financeiro além do necessário no ambiente de execução.

## Controles positivos planejados

Aceitar os três exemplos vigentes e os valores esperados de ORACULOS_DOS_EXEMPLOS.json. Para o motor de prévia, conferir também os quatro vetores de domínio de vetores-totalizacao.json. O vetor CAT04 testa a normalização de entrada; essa normalização deve ocorrer antes de gerar um manifesto.

Verificar expressamente que novembro não recebe a categoria de despesa do registro de contexto de outubro, que outubro não recebe as transferências de contexto de novembro e que TRANSFERENCIAS permanece em novembro mesmo com netCents igual a zero.

## Controles negativos planejados

Rejeitar categoryTotals ausente, categoria duplicada, categoria omitida, categoria extra de contexto, entrada/saída errada, saldo líquido inconsistente, ordem trocada, texto não normalizado e exclusão de grupo com saldo zero. Campos com tipo incorreto devem ser rejeitados estruturalmente pelo JSON Schema; somas incorretas com tipos válidos devem ser rejeitadas semanticamente.

Para exercitar o controle semântico do CLI, usar um manifesto de laboratório e sua referência externa igualmente preparados com a mesma inconsistência, além de arquivos cujos hashes estejam válidos. Caso contrário, o teste pode parar na comparação de bytes e nunca avaliar a totalização. Esses controles são fixtures propositalmente inválidas; não são manifestos reais considerados confiáveis quanto ao conteúdo financeiro.

Integrar esses aceites aos testes de desenvolvimento de I06, I08 e I09, e aos oráculos de RF-09/RF-12/RF-14. As contagens e procedimentos formais C01-C06 permanecem os de requirements.md; os controles novos não são resultados já coletados nem substituem a avaliação formal.
