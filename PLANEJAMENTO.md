# Planejamento — mcp-dev-agent

O objetivo original — disponibilizar por MCP capacidades de desenvolvimento da VM para clientes autorizados — está implementado.

A versão atual é `1.2.0`. As prioridades anteriores de auditoria, testes de integração e validação de proxy foram concluídas.

## Próximas prioridades

1. adicionar captura de screenshot nativa, preferencialmente com Playwright e retorno `ImageContent` MCP;
2. avaliar `search_files` estruturado e paginado para reduzir dependência de saída livre de shell;
3. avaliar conceito opcional de workspace ativo para navegação entre projetos;
4. consolidar hardening do perímetro com rate limiting/WAF no Cloudflare;
5. remover pequenas duplicações de manutenção, como a versão hardcoded em mais de um arquivo.

## Documentação relacionada

- [`docs/AVALIACAO-TECNICA.md`](docs/AVALIACAO-TECNICA.md) — diagnóstico atualizado e ordem de evolução;
- [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) — arquitetura e limitações estruturais;
- [`docs/SEGURANCA.md`](docs/SEGURANCA.md) — riscos e hardening;
- [`docs/DESENVOLVIMENTO.md`](docs/DESENVOLVIMENTO.md) — critérios de pronto e manutenção.

Evite duplicar aqui detalhes que já tenham um documento proprietário em `docs/`.
