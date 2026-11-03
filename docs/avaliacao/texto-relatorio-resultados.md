# Texto para o relatório: resultados da avaliação C01–C06

Proposta de texto para substituir, no `Relatorio_TCC_v04`, a seção 4.3 (evidências e "Resultado observado" das fichas), a seção 5 e a seção 6. As seções 4.1 e 4.2 permanecem como plano; as diferenças entre o plano e a execução estão declaradas abaixo. Fonte de todos os números: `docs/avaliacao/resultados/` (tag `poc-v1.0.0`).

---

## 4.3 Evidências da Avaliação

Os seis cenários foram executados em 02/11/2026 sobre a versão `poc-v1.0.0` da prova de conceito (commit `14605c6`, incrementos I01–I16). Antes da coleta, um protocolo fixou a massa, os pontos de falha, a matriz de autorização, as mutações e as medições de cada cenário (`docs/avaliacao/protocolo-c01-c06.md`). O código do produto não foi alterado durante a avaliação: os commits posteriores à tag acrescentam apenas documentação e scripts de avaliação, e cada resultado registra essa condição.

Ambiente: Windows 11 Pro, Docker Desktop 29.9.2 sobre WSL2 (kernel 6.18), processador Intel Core i7-13620H, PostgreSQL 18.6 e Node 24.22.1 em contêineres. Cada cenário usou projeto e volume Docker novos, massa sintética gerada por script e a API real acessada por HTTP. Os registros sanitizados (JSON e Markdown) identificam commit, ambiente, esperado, observado e veredito.

| Cenário | RNF | Medida planejada | Resultado observado | Veredito |
| --- | --- | --- | --- | --- |
| C01 | RNF-01 | 100 intercalações sem mistura de revisões | 100/100 corretas; 0 misturas; entrega anterior idêntica byte a byte em 100/100 | Atende |
| C02 | RNF-02 | 30 falhas transitórias recuperadas em até 120 s | 30/30 em PRONTA; 0 FALHA terminal; maior tempo 28,3 s | Atende |
| C03 | RNF-03 | 36 recusas e 12 controles positivos | 36/36 recusas sem vazamento nem mutação; 12/12 controles aceitos | Atende |
| C04 | RNF-04 | 20 divergências detectadas e controle íntegro aceito | 20/20 detectadas; controle íntegro aceito; limitação demonstrada | Atende |
| C05 | RNF-05 | 20 registros em duas combinações, offline | 20/20 no Linux (Chromium e LibreOffice); Firefox no Windows; sem LibreOffice no Windows | Atende com desvio declarado |
| C06 | RNF-06 | p95 ≤ 10 s; pico RSS ≤ 512 MiB | p95 2,06 s; pico RSS 321,5 MiB | Atende |

Seis execuções foram invalidadas por defeito do próprio harness ou do ambiente (três no C01, uma no C04 e duas no C06), nenhuma por falha do produto. Todas foram mantidas com o motivo registrado; as que produziram resultado completo estão preservadas no histórico. No C01, a primeira execução completa usava uma verificação derivada que contradizia o desenho documentado (a captura não incrementa a revisão); o protocolo recebeu errata antes da repetição integral do cenário, sem mudar o critério do requisito.

**C01 — Consistência.** Em cada uma das 100 execuções, um espaço novo recebeu uma entrega v1 publicada; com a linha do espaço bloqueada, a captura e uma mutação foram enviadas com a mesma revisão e liberadas em ordem controlada. Os quatro tipos de mutação (correção de valor, upload de documento, vínculo de reembolso e justificativa de pendência) tiveram 25 execuções cada, 13 com a captura atendida primeiro e 12 com a mutação atendida primeiro. Quando a captura venceu, o manifesto coincidiu com a prévia da revisão lida e o pacote passou no verificador; quando a mutação venceu, a captura recebeu HTTP 409 sem criar versão. Não houve mistura de revisões, e os bytes da v1 foram preservados em todas as execuções.

**C02 — Recuperação.** O executor de produção rodou em processo próprio, instrumentado para pausar em cinco pontos: aquisição da operação, leitura do snapshot, leitura dos anexos e publicação, com o banco parado em cada um, e encerramento do processo do executor durante a montagem. As 30 execuções terminaram em PRONTA, com um único pacote e uma única versão por snapshot, pacote verificado e no máximo duas tentativas. O maior tempo entre o restabelecimento e a publicação foi 22,7 s nos pontos com banco parado e 28,3 s no encerramento do processo, que depende da expiração do lease de 30 s.

**C03 — Segurança.** Doze operações sobre objetos do proprietário A (leitura, alteração, exclusão, upload, download, substituição e desvínculo de documento, pendência, prévia, consulta de operação, download de pacote e reembolso) foram tentadas sem sessão, com sessão do proprietário B e por vínculo entre espaços, totalizando 36 casos. Todos foram recusados (401 ou 404), com revisão, contagens e conteúdo dos dois espaços iguais antes e depois de cada caso e sem dados do outro espaço no corpo de erro. Como verificação adicional, as 12 operações com sessão revogada por logout também foram recusadas. Os 12 controles positivos foram aceitos, o que afasta a hipótese de rotas que sempre recusam.

**C04 — Integridade.** O verificador offline foi executado em processo separado contra 20 mutações de um pacote real, com o manifesto de referência baixado da API e guardado fora do pacote. Detectou as 20 (alteração, ausência, arquivo extra e referência inválida, cinco de cada), com código de diagnóstico coerente com a classe, e aceitou o pacote íntegro. Também recusou o uso do manifesto interno do pacote como referência (autorreferência). O controle de limitação confirmou o comportamento esperado: um pacote adulterado é aceito quando a própria referência apresentada foi adulterada. A garantia depende, portanto, de a referência vir de um canal confiável.

**C05 — Consulta offline.** A entrega de referência tinha 20 lançamentos com acentos, valores de um centavo a bilhões, contas PF e PJ, reembolso entre meses, pendências e documentos. No Linux (Debian 12, contêiner sem rede), o resumo aberto no Chromium 156 coincidiu com o oráculo nos 20 registros (180 campos), e o CSV convertido pelo LibreOffice 7.4.7.2 também (160 campos). No Windows, o resumo foi aberto no Firefox 159 por `file://`, sem rede, e conferido pelo autor junto com o restante. O LibreOffice não foi instalado no Windows, e a leitura do CSV por planilha nessa plataforma não foi verificada; esse desvio consta da errata do protocolo.

**C06 — Desempenho.** A geração de 200 movimentações com 50 anexos (25 MiB) teve 30 amostras válidas após três aquecimentos: mínimo 0,76 s, mediana 2,01 s, p95 2,06 s e máximo 2,08 s, com ZIP de cerca de 25 MiB baixado integralmente após cada geração. O pico de RSS da API na geração e no download foi 321,5 MiB. No teste de limite, com 100 MiB de anexos, a operação terminou em PRONTA em 1,96 s e o download foi completo, mas o pico de RSS chegou a 658 MiB. Esse teste não tem meta de memória, mas indica que a montagem do pacote não mantém a memória constante com o tamanho dos anexos.

### Diferenças entre o plano (seção 4.2) e a execução

- **C02**: o plano descrevia a falha pela perspectiva do comando (antes ou depois do commit da captura, durante o ZIP, antes ou depois da publicação). O protocolo a fixou nas operações reais do executor, que concentra a captura assíncrona e a publicação. Os controles adicionais de recuperação (mesma chave com payload diferente, tentativas esgotadas, publicação com token antigo) não fizeram parte desta avaliação. A evidência do incremento I08 registra, em testes de integração, a rejeição de publicação com token antigo, o encerramento em FALHA após três tentativas e a repetição idempotente do comando; esses testes não substituem uma medição formal.
- **C03**: a matriz executada trocou duas operações fixadas no protocolo (vínculo de documento existente e geração da entrega) por substituição e desvínculo de documento; a geração da entrega (`POST /deliveries`) não foi testada sem sessão nem por outro proprietário. Cinco dos 36 casos são listagens ou leituras do próprio B e só reprovariam por vazamento de identificador. A condição "sessão expirada" foi substituída por "vínculo entre espaços" na contagem de 36, e a sessão revogada por logout foi verificada como caso adicional. Essas diferenças foram identificadas na revisão do harness, após a coleta. A sessão expirada por tempo e as verificações de token CSRF ausente ou inválido não foram exercitadas no C03; o protocolo usou CSRF válido em todas as mutações para isolar a autorização.
- **C05**: Windows sem LibreOffice (errata E3).
- **C06**: em vez de um host Linux de 2 vCPU e 4 GiB, API e banco compartilharam 2 núcleos e 4 GiB no Docker Desktop sobre WSL2. A duração foi medida no relógio do banco (do registro do comando ao commit do pacote), e não por relógio monotônico do cliente.
- **C02, medição**: o plano ancorava o tempo na API pronta; o harness ancorou no fim da espera pelo healthcheck do banco, que ocorre depois da restauração real. Os tempos do C02 estão subestimados em até cerca de 2 s, o que não altera o veredito (28,3 s ante 120 s).

### Resultado observado nas fichas

| Ficha | Resultado observado |
| --- | --- |
| C01 | 100/100 intercalações corretas (25 por tipo); 0 misturas; v1 preservada em 100/100. Atende. |
| C02 | 30/30 recuperadas (6 por ponto); 0 FALHA; maior tempo 28,3 s após restabelecimento; até 2 tentativas. Atende. |
| C03 | 36/36 recusas, 12/12 com sessão revogada, 12/12 controles aceitos, sem vazamento nem mutação, na matriz executada (geração da entrega fora). Atende. |
| C04 | 20/20 detectadas; controle íntegro aceito; autorreferência recusada; limitação sem referência confiável demonstrada. Atende. |
| C05 | 20/20 registros iguais ao oráculo no Chromium e no LibreOffice (Linux) e conferidos no Firefox (Windows); LibreOffice no Windows não executado. Atende com desvio declarado. |
| C06 | p95 2,06 s; pico RSS 321,5 MiB; limite de 100 MiB concluído com pico de 658 MiB. Atende. |

---

## 5 Avaliação Crítica dos Resultados

Os seis cenários atenderam às metas fixadas, com um desvio declarado no C05. O resultado sustenta as decisões arquiteturais avaliadas dentro dos limites do experimento, mas não as prova em geral.

A serialização por espaço com revisão (C01) não produziu mistura de conteúdo em 100 intercalações forçadas. O custo previsto se confirmou: a captura com revisão obsoleta é rejeitada, e o usuário precisa repetir o comando. A operação persistida com lease (C02) recuperou todas as falhas transitórias. O tempo de recuperação, porém, é dominado pelos parâmetros de tentativa e lease (cerca de 22 s com o banco parado e 28 s com o processo encerrado), não pelo trabalho de montagem. Essa folga cabe na meta de 120 s, mas é o primeiro parâmetro a revisar se a meta encurtar.

A autorização por objeto (C03) recusou todas as tentativas da matriz sem revelar existência de objetos alheios. A cobertura é a da matriz executada: não equivale a auditoria de segurança, e a geração da entrega por terceiro, a expiração por tempo e o CSRF inválido ficaram fora desta medição. O verificador (C04) detectou todas as divergências em relação a uma referência confiável. O controle de limitação mostra, com dado observado, o que o relatório já declarava: sem referência obtida por canal confiável, o verificador não distingue um pacote adulterado de um íntegro, porque não há assinatura nem autenticação de origem.

O pacote offline (C05) preservou datas, acentos, valores e relações nos leitores testados. A conferência foi feita pelo próprio autor, e a planilha não foi verificada no Windows; o resultado mostra portabilidade técnica, não usabilidade para contadores. No desempenho (C06), o p95 ficou cerca de cinco vezes abaixo da meta, mas as amostras se concentram em torno de 2 s porque o executor consulta a fila a cada 2 s. O número mede sobretudo o intervalo de polling, e não o custo de montagem. A memória ficou abaixo do limite na carga nominal, mas o teste de 100 MiB atingiu 658 MiB. Isso confirma o risco de "ZIP materializado" identificado na ficha C06 e indica a montagem em fluxo contínuo como próxima correção, se o acervo crescer.

As ameaças à validade permanecem: ambiente Docker sobre WSL2, e não um host dedicado; executor do C02 fora do processo da API, com pausa provocada pelo harness e tempo ancorado depois da restauração real; conferência do C05 pelo autor; harness e produto escritos pela mesma pessoa, risco mitigado por critérios fixados antes da coleta, oráculos gerados dos dados e verificador independente; dados sintéticos. Seis execuções foram invalidadas por defeitos do harness e estão registradas com o motivo.

Na dimensão de negócio, as limitações anteriores continuam válidas. A entrada é manual ou por CSV próprio, sem OFX, Open Finance ou OCR. HTML e CSV próprios não têm interoperabilidade contábil demonstrada. O vínculo PF/PJ organiza a informação, mas não determina tratamento fiscal, e o contrato não garante anonimização ou expurgo de movimentações pessoais. Nenhum cenário mediu redução de retrabalho ou aceitação por contadores; estudos locais e documentação de fornecedores sustentam o contexto, mas não validam o produto.

## 6 Conclusão

A prova de conceito implementou os 14 requisitos funcionais e foi avaliada nos seis cenários de qualidade, com veredito de atendimento em todos, um deles com desvio declarado. Os resultados indicam que um único banco transacional, com captura em snapshot imutável, executor com lease e pacote offline verificável contra referência externa, atende às metas de consistência, recuperação, isolamento, integridade, portabilidade e desempenho na escala delimitada. O custo é a vazão limitada e o crescimento do banco. As medições também apontaram onde o desenho deve evoluir: memória na montagem de pacotes grandes, tempo de recuperação ligado aos parâmetros de lease e dependência de canal confiável para a referência do verificador. O valor do produto para contadores e a redução de retrabalho continuam sem validação empírica. Armazenamento externo de binários, colaboração com o contador e outros formatos de importação permanecem como evoluções fora do escopo atual.
