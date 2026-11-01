# CLI independente (`@mimir/verifier`)

Verificador offline e sem rede de pacotes de entrega mensal (`mimir.manifest.v2`), implementando RF-09/RF-14 e os controles de [verifier-acceptance](../../docs/verifier-acceptance.md) e [export-format](../../docs/export-format.md).

## Uso

```sh
node packages/verifier/dist/index.js <diretorio-extraido> <manifesto-externo.json>
# ou:
node packages/verifier/dist/index.js --package-dir <diretorio-extraido> --reference-manifest <manifesto-externo.json>
```

Via Docker Compose (`network_mode: none`, `read_only: true`, `cap_drop: [ALL]`):

```sh
docker compose run --build --rm --no-deps -v /caminho/pacote:/pkg:ro -v /caminho/referencia.manifesto.json:/ref.json:ro verifier /pkg /ref.json
```

## Códigos de saída

- `0`: pacote íntegro, estrutural e semanticamente válido contra o manifesto de referência externo; imprime mensagem sanitizada `VERIFIED: ...` em `stdout`.
- `1`: violação de integridade, estrutura, relação ou cálculo detectada; imprime código e mensagem sanitizada em `stderr` (sem vazar descrições privadas, justificativas ou notas).
- `2`: erro de invocação (argumentos ausentes/inválidos, caminhos inexistentes, tipos de caminho incorretos ou manifesto de referência apontando para o próprio `manifesto.json` interno do pacote).
