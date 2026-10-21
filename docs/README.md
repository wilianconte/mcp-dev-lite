# Documentação do mcp-dev-agent

Este diretório concentra a documentação técnica e operacional do `mcp-dev-agent`.

## Por onde começar

| Documento | Quando usar |
|---|---|
| [`../README.md`](../README.md) | Visão rápida, instalação e conexão de clientes MCP. |
| [`ARQUITETURA.md`](./ARQUITETURA.md) | Entender componentes, autenticação, sessões, persistência e fluxo das chamadas. |
| [`FERRAMENTAS.md`](./FERRAMENTAS.md) | Consultar o contrato, matriz de decisão e boas práticas das 16 ferramentas MCP. |
| [`OPERACAO.md`](./OPERACAO.md) | Subir, validar, diagnosticar e manter o serviço. |
| [`SEGURANCA.md`](./SEGURANCA.md) | Entender o modelo de ameaça, controles existentes e riscos aceitos. |
| [`DESENVOLVIMENTO.md`](./DESENVOLVIMENTO.md) | Alterar o código, adicionar ferramentas e executar validações. |
| [`DEPLOY-CLOUDFLARE.md`](./DEPLOY-CLOUDFLARE.md) | Publicar com HTTPS usando Cloudflare Tunnel. |
| [`AVALIACAO-TECNICA.md`](./AVALIACAO-TECNICA.md) | Ver o diagnóstico atual da aplicação e prioridades de evolução. |
| [`RECOMENDACAO.md`](./RECOMENDACAO.md) | Registro das recomendações arquiteturais iniciais. |

## Fonte de verdade

Para evitar duplicação e divergência:

- **README raiz:** onboarding e quick start.
- **ARQUITETURA:** desenho do sistema e decisões estruturais.
- **FERRAMENTAS:** contrato funcional e guia de uso exposto pelo MCP.
- **OPERACAO:** runbook do serviço.
- **SEGURANCA:** riscos, controles e checklist de hardening.
- **DESENVOLVIMENTO:** workflow de contribuição e testes.
- **AVALIACAO-TECNICA:** fotografia do estado atual; deve registrar a data da avaliação.

Quando uma mudança de código alterar comportamento, atualize o documento proprietário daquele assunto na mesma alteração.

## Estado atual resumido

A versão em desenvolvimento é `1.4.0` e expõe 16 ferramentas. O projeto usa Node.js 20+, TypeScript em modo estrito, Express, o SDK oficial do Model Context Protocol e transporte Streamable HTTP.

O servidor aceita autenticação por token estático e OAuth 2.1, mantém sessões MCP em memória e permite execução arbitrária de shell e acesso irrestrito ao filesystem do usuário do processo. Essa autonomia é intencional e deve ser tratada como uma fronteira de segurança crítica.
