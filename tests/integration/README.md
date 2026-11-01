# Integração I01–I05

Na raiz: tools/test-docker.ps1 (Windows) ou sh tools/test-docker.sh (Linux). PostgreSQL real sem mocks, projeto/volume/configuração novos, fixtures sintéticas e credenciais separadas. Script POSIX ainda não executado integralmente em host Linux.

database.test.mjs cobre migrações/integridade/privilégios; auth.test.mjs cobre provisão/sessão/HTTP/rollback; accounts.test.mjs cobre contas/paginação/revisão/concorrência. transactions.test.mjs cobre contrato manual PF/PJ, datas/centavos/Unicode, dono/atividade, concorrência, revisão, pendências, FKs/grants e rollback após inserções. Supervisor observa espera real de lock antes de revogar/expirar sessão ou mudar conta; revogação durante lock da própria conta também reverte agregado.

Probes na API do contêiner testam login, conta, lançamento PF empresarial/duas pendências e preservação de sessão/expiração/revisão/objetos após recriar serviços. Incluem outage sanitizado, logout, auditoria administrativa e HMR. Volumes preservados inclusive em falha. Evidência em docs/evidence/I04.md; contagens incluem agrupadores node:test.

I05: documents.test.mjs cobre upload/multipart/tipos/tamanhos exatos, bytes/hash SQL, pendências/grants mínimos, concorrência, rollback após documento/vínculo/reconciliação e revogação sob locks reais. Inclui corpo chunked e duas admissões até o commit/rollback. Probe real confere documento/vínculo/pendências/revisão 4 após recriação. A sonda I01 seleciona apenas hash/bytes sintéticos originais, sem presumir contagem global de documentos. Resultados em docs/evidence/I05.md.
