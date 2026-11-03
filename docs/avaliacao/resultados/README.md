# Resultados da avaliação formal C01–C06

Versão avaliada: tag `poc-v1.0.0` (commit `14605c6`, I01–I16). Protocolo fixado antes da coleta em [`../protocolo-c01-c06.md`](../protocolo-c01-c06.md). Os commits da branch de avaliação só acrescentam documentação e `tools/avaliacao/`; cada resultado registra `productEqualToTag`.

## Veredito por requisito

| RNF | Cenário | Veredito | Números principais |
| --- | --- | --- | --- |
| RNF-01 | [C01](C01.md) | atende | 100/100 intercalações corretas; 0 misturas de revisão; entrega v1 preservada em 100/100 |
| RNF-02 | [C02](C02.md) | atende | 30/30 recuperadas; 0 FALHA terminal; maior tempo após restauração 28,3 s (meta 120 s) |
| RNF-03 | [C03](C03.md) | atende | Matriz da §4 (repetição após E4): 36/36 negativos bloqueados, 12/12 com sessão revogada, 12/12 controles positivos aceitos |
| RNF-04 | [C04](C04.md) | atende | 20/20 mutações detectadas (5 por classe); controle íntegro aceito; limitação sem referência confiável documentada |
| RNF-05 | [C05](C05.md) | atende com desvio declarado | 20/20 registros iguais ao oráculo no Chromium (180 campos) e no LibreOffice (160 campos); Firefox no Windows conferido pelo usuário; Windows/LibreOffice não executado (E3) |
| RNF-06 | [C06](C06.md) | atende | 30/30 prontas; p95 2.057 ms (meta 10 s); pico de RSS 321,5 MiB (meta 512 MiB) |

Veredito de C05 e a conferência dos 20 registros: **VERIFICADO** para as comparações automáticas (`comparacao-c05.json`); a conferência final é decisão do autor, registrada em `C05.json` (`userCheck`).

## Desvios e erratas

- **E1 (C01)**: a verificação derivada "uma das duas operações vence, a outra recebe 409" contradizia o desenho (a captura não incrementa a revisão). Verificações corrigidas por ordem atendida, critério de `requirements.md` inalterado, C01 repetido por inteiro. Primeira execução mantida em `historico/`.
- **E2 (C06)**: a coluna de medição é `delivery_packages.created_at`, não `published_at`. A medição é a mesma, definida antes da coleta.
- **E3 (C05)**: o LibreOffice não foi instalado no Windows (elevação de privilégio, instalação cancelada pelo autor). A planilha foi conferida só no LibreOffice 7.4.7.2 do contêiner Debian 12; no Windows, só o Firefox 159.0 offline. Nenhuma biblioteca substitui o LibreOffice.
- **E4 (C03)**: duas operações da matriz do protocolo foram trocadas na execução; `POST /deliveries` não foi testado sem sessão nem por outro proprietário, e 5 dos 36 casos só reprovariam por vazamento. Registrada após a coleta; o C03 foi repetido com a matriz da §4 (36/36, 12/12, 12/12), e a execução anterior está em `historico/`.
- **E5 (C02)**: a âncora do tempo foi o fim do `up --wait db`, não `/ready` 200; os tempos estão subestimados em até ~2 s. Registrada após a coleta; veredito inalterado.
- **C02**: o executor roda fora do processo da API e a falha é injetada por decorador do harness (desvio previsto no protocolo §3).
- **C06**: Docker Desktop/WSL2 com API e banco em 2 núcleos e 4 GiB somados, não host dedicado.

## Execuções inválidas

Todas por defeito do harness ou do ambiente, nenhuma por falha do produto; registradas em [`../../../tools/avaliacao/execucoes-invalidas.json`](../../../tools/avaliacao/execucoes-invalidas.json) e, quando houve resultado completo, em `historico/`.

| Cenário | Projeto | Motivo |
| --- | --- | --- |
| C01 | `mimir-eval-c01-bb8b62c5` | Verificação derivada incorreta (errata E1); 48/100; mantida em `historico/` |
| C01 | `mimir-eval-c01-1546d146` | `pg_stat_activity.wait_event_type` invisível ao papel do harness; contagem sempre 0; interrompida sem resultado |
| C01 | `mimir-eval-c01-a95482fa` | Docker esgotou os pools de endereço de rede; nenhuma intercalação executada |
| C04 | `mimir-eval-c04-5714b6d2` | Conjunto de diagnósticos da classe `extra` sem `SYMLINK_FORBIDDEN` e controle de limitação com autorreferência |
| C06 | `mimir-eval-c06-82341a9d` | Filtro de `VmHWM` pegou o `sh -c` da medição (pico 0,7 MiB); mantida em `historico/` |
| C06 | `mimir-eval-c06-56ccf9ba` | Filtro exigia `comm=node`, mas a API se renomeia para `MainThread`; abortada sem resultado |

## Ameaças à validade

Protocolo §8: C06 em Docker limitado sobre WSL2, não host dedicado; C02 roda o executor fora do processo da API e pausa por decorador do harness; C05 conferido pelo próprio autor; harness escrito pelo mesmo autor do produto (mitigado por oráculos independentes, verificador offline e critérios fixados antes da coleta); dados sintéticos.

Observações da coleta:

- **C02, âncora (E5)**: a âncora é lida depois do healthcheck do banco (intervalo de 2 s) e de um sinal por arquivo, portanto **depois** da restauração real. Os valores negativos do P1 (de −1,2 a −0,5 s) são publicações anteriores à âncora, e todos os tempos estão subestimados em até ~2 s (**INFERIDO**).
- **C06, tempos agrupados**: o executor consulta a fila a cada 2 s, então as amostras se concentram perto de 2 s (mediana 2.007 ms). O p95 mede principalmente o intervalo de polling, não o custo de montagem.
- **C06, limite de 100 MiB**: a geração terminou PRONTA em 1.962 ms, mas o pico de RSS foi 658 MiB, acima dos 512 MiB da meta de 25 MiB. O protocolo não fixa meta para esse teste, então não altera o veredito; sugere que a montagem do ZIP mantém o conteúdo em memória (**INFERIDO**; não investigado).
- **C05**: sem a combinação Windows/LibreOffice (E3) a portabilidade da planilha no Windows é **INFERIDA** a partir do Linux.

## Como reproduzir

A partir da raiz do repositório, com Docker Desktop em execução e a tag `poc-v1.0.0` (ou branch com produto igual):

- `tools/avaliacao/run.ps1 -Scenario C01` (idem `C03`, `C04`): projeto Docker novo; resultado em `.local/mimir-eval-<cenário>-<id>/out/`.
- `tools/avaliacao/run.ps1 -Scenario C05`: gera pacote e oráculo. As combinações de navegador e planilha são executadas à parte (Chromium e LibreOffice em contêiner sem rede; Firefox com perfil descartável e proxy em porta morta); depois `tools/avaliacao/c05-conferencia.mjs` monta a comparação e a planilha de conferência, e `tools/avaliacao/c05-resultado.mjs <out> docs/avaliacao/resultados 20/20 <versão do Firefox>` grava `C05.json` e `C05.md`.
- `tools/avaliacao/c02.ps1`: orquestrador do C02 no host (para o banco, reinicia, encerra o executor).
- `tools/avaliacao/c06.ps1`: limites de contêiner, massa de 25 MiB, aquecimentos, 30 amostras, RSS e teste de 100 MiB.

Cada cenário gera um projeto Docker `mimir-eval-*` novo; os resultados sanitizados são copiados para esta pasta.
