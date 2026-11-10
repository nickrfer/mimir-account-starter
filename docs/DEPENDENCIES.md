# Versões e licenças - I01, 31/10/2026

Versões exatas no package.json de cada workspace e em pnpm-lock.yaml. Node instalado foi mantido; nenhum gerenciador paralelo ou runtime global foi instalado.

| Componente | Versão fixada/observada | Licença |
| --- | --- | --- |
| Node.js | 24.22.1 LTS (host e imagem) | MIT, com avisos de componentes incluídos |
| pnpm | 12.16.1 (host e build Linux) | MIT |
| TypeScript | 7.0.2 | Apache-2.0 |
| React / React DOM | 19.3.1 | MIT |
| Vite | 8.3.5 | MIT |
| pg | 8.23.1 | MIT |
| @node-rs/argon2 (I02) | 2.2.2 | MIT |
| @types/node | 24.10.15 | MIT |
| @types/pg | 8.23.1 | MIT |
| @types/react / @types/react-dom | 19.3.0 | MIT |
| PostgreSQL | 18.6-bookworm | PostgreSQL License |
| Docker Engine / Compose | 29.9.2 / 5.6.1 observados no host | Apache-2.0 nos projetos de código aberto; Docker Desktop tem termos próprios |

Imagens fixadas por digest, além da versão, em Dockerfile e compose.yaml:

- Node: `sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c`.
- PostgreSQL: `sha256:5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8`.

Consultas npm foram executadas com `npmview <pacote> version license engines`, usando NODE_OPTIONS=--use-system-ca para confiar no repositório de certificados do Windows. Não foi desativada a validação TLS. O engine do Vite exige Node ^20.19.0 ou >=22.12.0; pg exige >=16. O projeto limita Node a >=24.22.1 <25, alinhado à versão LTS instalada e à imagem. O build foi exercitado no Windows e em Linux.

`pnpmlicenses list --json` e `pnpm--filter @mimir/web licenses list --json` conferiram as dependências instaladas. Licenças transitivas observadas: MIT, Apache-2.0, ISC, BSD-3-Clause e MPL-2.0 (lightningcss 1.33.0, ferramenta de build não alterada). São compatíveis com o uso proposto; a licença própria MIT não substitui os avisos dos componentes. Inventário sanitizado em [dependencies.json](evidence/dependencies.json). Binários opcionais por SO/CPU também estão resolvidos no lockfile. As imagens mantêm suas licenças de distribuição e componentes.

Fontes oficiais consultadas:

- [Release oficial Node 24.22.1 LTS](https://nodejs.org/en/blog/release/v24.22.1) e [calendário de suporte](https://github.com/nodejs/Release).
- [TypeScript via npm e lockfiles](https://www.typescriptlang.org/download/); metadados exatos no [registro TypeScript](https://registry.npmjs.org/typescript/7.0.2).
- [Versões React](https://react.dev/versions), [registro React](https://registry.npmjs.org/react/19.3.1) e [React DOM](https://registry.npmjs.org/react-dom/19.3.1).
- [Requisitos Vite](https://vite.dev/guide/) e [registro Vite](https://registry.npmjs.org/vite/8.3.5).
- [Driver pg e tipos PostgreSQL](https://node-postgres.com/features/types), [consultas parametrizadas](https://node-postgres.com/features/queries), [transações](https://node-postgres.com/features/transactions) e [registro pg](https://registry.npmjs.org/pg/8.23.1).
- [Releases PostgreSQL](https://www.postgresql.org/docs/release/), [licença](https://www.postgresql.org/about/licence/) e [imagem oficial, volume PostgreSQL 18](https://hub.docker.com/_/postgres).
- [SQLSTATE PostgreSQL 18](https://www.postgresql.org/docs/18/errcodes-appendix.html): RESTRICT usa 23001, diferente de 23503 para referência inexistente.

Não há garantia de atualização automática: novas versões exigem revisão do lockfile, dos digests e repetição das verificações.

## Adição I02

@node-rs/argon2 2.2.2 fixado no workspace API e no lockfile; biblioteca N-API com binários pré-compilados, sem toolchain nativa adicional no host. Metadados consultados em contêiner: versão 2.2.2, MIT, engine Node >=10. Testado com Node 24.22.1/Linux amd64 no Docker Desktop Windows; não foi repetido build Node nativo Windows nesta etapa. Lockfile foi resolvido em diretório temporário de metadados no contêiner e copiado de volta, sem instalar ferramenta global.

Política: Argon2id v19, 65536 KiB, tempo 3, paralelismo 1, saída 32 bytes. Consulta oficial de tipos mostrou const enums ambientais; foram usados valores públicos numéricos tipados em Options para manter verbatimModuleSyntax estrito, sem alterar tsconfig. Medição de 5 amostras: hash mediana 98 ms (93–125); verificação 96 ms (94–103), neste ambiente somente. [Medição sanitizada](evidence/I02-argon2.json).

Fontes: [pacote oficial](https://github.com/napi-rs/node-rs/tree/main/packages/argon2), [tipos/opções oficiais](https://github.com/napi-rs/node-rs/blob/main/packages/argon2/index.d.ts), [metadados da versão](https://registry.npmjs.org/@node-rs/argon2/2.2.2) e [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Nenhum SDK de IA foi adicionado.

`pnpm --filter @mimir/api licenses list --json` executado na imagem administrativa confirmou MIT também para o binário linux-x64-gnu 2.2.2. Inventário separado em [I02-dependencies.json](evidence/I02-dependencies.json), sem sobrescrever o de I01.
