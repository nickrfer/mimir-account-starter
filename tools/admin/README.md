# Administração local

setup.mjs gera configuração/segredos locais sem imprimi-los ou sobrescrever arquivos. Bootstrap Docker dispensa Node no host. database.mjs provisiona papéis e aplica migrações versionadas com credenciais separadas do runtime.

cli.mjs oferece migrate e create-owner. create-owner recebe exatamente email/displayName/companyName/password por stdin JSON UTF-8 limitado a 8 KiB; cria usuário/espaço atomicamente e retorna só IDs. Não aceita senha em argumentos. Erros exibem código sanitizado; API nunca lê .env.admin. Instruções seguras e limites em [authentication](../../docs/authentication.md).

integration.mjs é entrada opcional Node host que delega aos scripts nativos tools/test-docker.ps1 ou .sh. Testes/probes executam em contêiner, com PostgreSQL real e volumes isolados preservados. Rotação de credenciais existentes não é automatizada; conservar configuração junto do volume. [README](../../README.md).
