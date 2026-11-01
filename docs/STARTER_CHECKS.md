# Conferências do scaffold

Em 31/10/2026, foram conferidos a estrutura documental, o OpenAPI 3.1, o JSON Schema do manifesto v2 e os três manifestos sintéticos. Os contratos, vetores e arquivos declarados nos manifestos preservam os bytes da base documental vigente. Tamanhos e SHA-256 de 13 arquivos de saída e as três cópias externas de referência conferem.

O comportamento do .gitignore foi exercitado com Git em diretório de teste separado: .env, .env.admin, .env.runtime, secrets e node_modules são ignorados; arquivos .example e fixtures permanecem disponíveis para versionamento. Não há configuração secreta preenchida, PDF/DOCX institucional, código-fonte da aplicação ou conversa privada no starter.

Não foram executados build da aplicação, banco, migrações ou testes do produto, pois ainda não foram implementados. I01 está pendente. Este documento descreve conferências de preparação; não comprova segurança de implementação nem execução de C01-C06.

O inventário SHA-256 inclui os arquivos do starter, exceto o próprio inventário. O ZIP foi conferido por CRC e por comparação dos bytes com esse inventário. O Git do projeto não foi inicializado e nenhum remoto foi criado.
