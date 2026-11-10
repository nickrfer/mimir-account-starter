# Extensão opcional: Assistente de preparação da entrega mensal

**Estado: proposta, não implementada.** Prevista somente depois da primeira jornada funcional (I02–I10), mediante incremento próprio. Não substitui CSV, reembolsos ou outros requisitos determinísticos pendentes. Nesta continuação não entram SDK, chave, endpoint, tela ou abstração de IA.

O usuário poderá pedir revisão de um mês antes de preparar a entrega ao contador. O modelo selecionará ferramentas de consulta conforme a necessidade: consultar prévia, listar pendências e consultar detalhes de movimentações autorizadas. A primeira versão terá ferramentas **somente de leitura**, sem SQL arbitrário, execução de código ou ferramenta de mutação. Essa seleção de consultas caracteriza a atuação do agente; respostas serão sugestões de categoria, explicações e perguntas vinculadas aos IDs dos registros, com justificativa e revisão de referência.

## Condições previstas

- IA desabilitada por padrão. Sistema completo funciona sem IA, chave, provedor ou acesso externo. Falha, limite excedido ou indisponibilidade não bloqueia prévia, edição, captura ou entrega.
- Integração inicial com API da OpenAI e chave própria da instalação, configurada apenas no backend. Chave ausente de frontend, Git, logs e respostas HTTP; nenhum segredo será gerado ou solicitado nesta fase documental.
- Limites explícitos de chamadas por solicitação/usuário, tokens, contexto e tempo, definidos/testados no incremento futuro antes de habilitar. Encerrar cadeia de ferramentas ao atingir orçamento; sem repetição ilimitada.
- Enviar somente dados selecionados e necessários ao mês/revisão solicitados. Não enviar automaticamente anexos ou conteúdo documental; futura ampliação exige consentimento e minimização específicos.
- Cada ferramenta autoriza novamente proprietário, espaço, mês e IDs usando identidade autenticada do backend. Argumentos produzidos pelo modelo não concedem acesso nem ampliam a seleção autorizada; UUID existente não prova autorização.
- Descrições, explicações, nomes e textos de movimentações/documentos são dados não confiáveis. Instruções embutidas nesses textos não alteram autorização, ferramentas, limites ou políticas do sistema. Validar argumentos e saídas estruturadas no backend.
- Sugestões explicitamente identificadas como sugestões, com justificativa e referências aos registros consultados. Sem referências inventadas ou alegação de acesso a anexos não enviados.
- Nenhuma alteração financeira, resolução de pendência ou captura de entrega será executada autonomamente pelo agente. O conjunto de ferramentas não conterá essas ações.
- Aplicação de sugestão ocorrerá por comando normal do sistema, após confirmação humana, autorização e validação de expectedRevision atual. Revisão divergente exige reavaliar a sugestão; retorno do modelo não contorna bloqueio/transação/revisão do domínio.
- Valores, datas, saldos e totais continuam calculados pelo domínio determinístico. IA não será fonte autoritativa de cálculos nem alterará manifesto/snapshot por conversa.
- Sem alegação de validação contábil, fiscal ou de dedutibilidade. Revisão assistida não substitui análise do contador.

## Aceites futuros, ainda não executados

Testar funcionamento integral com IA desligada/chave ausente, limites e timeout, falha do provedor, ID de outro proprietário, tentativa de ampliar seleção por ferramenta, prompt injection em textos, saída com IDs inexistentes e sugestão obsoleta. Demonstrar que ferramentas não escrevem e que somente comando normal confirmado pode aplicar mudança. Registrar dados enviados de forma sanitizada, sem conteúdo financeiro sensível ou segredos nos logs.

A documentação oficial descreve o ciclo de seleção/chamada de funções pelo modelo; quem executa e autoriza as funções continua sendo a aplicação. Esta proposta usa essa capacidade para consultas controladas, sem fixar modelo ou SDK antecipadamente. Referência consultada: [OpenAI Docs - Function calling](https://developers.openai.com/api/docs/guides/function-calling).
