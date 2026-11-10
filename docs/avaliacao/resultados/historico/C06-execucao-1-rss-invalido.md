# Resultado C06 - Desempenho (RNF-06)

Veredito: **atende** ao critério: Geração de 200 movimentações com 50 anexos (25 MiB): p95 ≤ 10 s (29ª de 30 amostras) após 3 aquecimentos; pico de RSS da API ≤ 512 MiB na geração e no download sequencial (RNF-06).

- Commit `3794fec1f3fc5c0b173fe2e9bf2e8fda4c89c98b` (tag `poc-v1.0.0`; produto igual à tag: sim); projeto `mimir-eval-c06-82341a9d`; Docker 29.9.2; PostgreSQL 18.6 (Debian 18.6-1.pgdg12+2); Node v24.22.1.
- Ambiente (desvio declarado): API e banco compartilham 2 núcleos e somam 4 GiB; Docker Desktop/WSL2, não host dedicado (desvio declarado). API cpuset 0,1; 2 GiB; banco cpuset 0,1; 2 GiB; harness em cpuset 2,3. Máquina física: 13th Gen Intel(R) Core(TM) i7-13620H (16 núcleos visíveis ao contêiner do harness), 10 GiB visíveis.
- API real (serviço `api` do `compose.yaml`, executor embutido, `/tmp` em tmpfs de 192 MB). Tempo = `delivery_packages.created_at − delivery_operations.created_at` (relógio do banco). Download sequencial do ZIP após cada geração. Pico de RSS = `VmHWM` do processo Node da API, com a API reiniciada após os aquecimentos.
- Amostras: 30/30 prontas; mínimo 882 ms, mediana 2024 ms, **p95 2081 ms**, máximo 2083 ms; ZIP 26266555 bytes; **pico de RSS 0.7 MiB**.
- Teste de limite (100 MiB, sem meta de tempo): 200 anexos, 104857600 bytes; estado PRONTA; 1796 ms; ZIP 104959492 bytes, baixado 104959492 bytes; pico de RSS 0.7 MiB.
- Aquecimentos (descartados): 539 ms, 1931 ms, 1964 ms.

| Amostra | Estado | Tempo (ms) | ZIP (bytes) | Baixado (bytes) |
| --- | --- | --- | --- | --- |
| 1 | PRONTA | 882 | 26266555 | 26266555 |
| 2 | PRONTA | 1963 | 26266556 | 26266556 |
| 3 | PRONTA | 2009 | 26266558 | 26266558 |
| 4 | PRONTA | 2040 | 26266555 | 26266555 |
| 5 | PRONTA | 1980 | 26266558 | 26266558 |
| 6 | PRONTA | 2015 | 26266559 | 26266559 |
| 7 | PRONTA | 1973 | 26266555 | 26266555 |
| 8 | PRONTA | 2038 | 26266558 | 26266558 |
| 9 | PRONTA | 2003 | 26266555 | 26266555 |
| 10 | PRONTA | 2046 | 26266555 | 26266555 |
| 11 | PRONTA | 2075 | 26266553 | 26266553 |
| 12 | PRONTA | 1944 | 26266557 | 26266557 |
| 13 | PRONTA | 2041 | 26266558 | 26266558 |
| 14 | PRONTA | 2073 | 26266559 | 26266559 |
| 15 | PRONTA | 2081 | 26266555 | 26266555 |
| 16 | PRONTA | 2064 | 26266559 | 26266559 |
| 17 | PRONTA | 2047 | 26266553 | 26266553 |
| 18 | PRONTA | 2024 | 26266554 | 26266554 |
| 19 | PRONTA | 1966 | 26266556 | 26266556 |
| 20 | PRONTA | 2048 | 26266554 | 26266554 |
| 21 | PRONTA | 2014 | 26266559 | 26266559 |
| 22 | PRONTA | 2009 | 26266562 | 26266562 |
| 23 | PRONTA | 2027 | 26266557 | 26266557 |
| 24 | PRONTA | 2083 | 26266559 | 26266559 |
| 25 | PRONTA | 2061 | 26266554 | 26266554 |
| 26 | PRONTA | 2005 | 26266561 | 26266561 |
| 27 | PRONTA | 1986 | 26266556 | 26266556 |
| 28 | PRONTA | 2005 | 26266553 | 26266553 |
| 29 | PRONTA | 1971 | 26266560 | 26266560 |
| 30 | PRONTA | 2025 | 26266558 | 26266558 |
