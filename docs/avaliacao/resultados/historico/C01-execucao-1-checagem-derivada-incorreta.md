# Resultado C01 — Consistência da captura (RNF-01)

Veredito: **não atende** ao critério: Nenhuma mistura de revisões nas 100 intercalações controladas (25 por tipo de mutação): snapshot consistente ou 409, com bytes anteriores preservados (RNF-01).

- Commit `d12005c7a407948a5a055fe25ccd881b28b1eb34` (tag `poc-v1.0.0`; produto igual à tag: sim); projeto `mimir-eval-c01-bb8b62c5`; Docker 29.9.2; PostgreSQL 18.6 (Debian 18.6-1.pgdg12+2); Node v24.22.1.
- Cada execução usa um espaço novo com 6 lançamentos, 3 documentos e 1 pendência, e uma entrega v1 publicada antes da intercalação. Com a linha do espaço bloqueada por uma conexão administrativa, captura e mutação são enviadas com a mesma revisão R, em ordem controlada (fila confirmada em `pg_locks`), e o bloqueio é liberado.
- Captura vencedora: manifesto publicado igual (canonicalizado) à prévia lida em R, `capturedRevision = R`, pacote aprovado pelo CLI do verificador. Mutação vencedora: nenhuma versão nova, revisão R+1, e a captura seguinte igual à prévia em R+1. Em todas: perdedora com 409 `REVISION_CONFLICT` e v1 byte a byte igual.
- Resultado: 48/100 execuções corretas; misturas observadas: 0; v1 preservada em 100/100. Substituições por defeito do harness: 2.

| Tipo | Mutação | Execuções | Corretas | Captura venceu | Mutação venceu |
| --- | --- | --- | --- | --- | --- |
| M1 | Correção de valor | 25 | 12 | 13 | 12 |
| M2 | Upload de documento | 25 | 12 | 13 | 12 |
| M3 | Vínculo de reembolso | 25 | 12 | 13 | 12 |
| M4 | Justificativa de pendência | 25 | 12 | 13 | 12 |
