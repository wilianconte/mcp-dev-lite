# MCP Hardening and KPI Integrity Design

## Intent

Fortalecer o servidor MCP atual sem quebrar o contrato das 17 ferramentas. O trabalho cobre os riscos observados na revisão do histórico e do painel de estatísticas.

## Goals

- Exigir autenticação nas rotas administrativas `/logs*`.
- Classificar resultados de comandos de forma separada entre erro de ferramenta, saída não zero, timeout, cancelamento e sucesso.
- Garantir persistência de auditoria coerente com a documentação e hidratação observável no startup.
- Serializar gravações e rotação do audit log.
- Correlacionar KPIs de edição e jobs com sessão, cliente e identificadores de operação quando disponíveis.
- Atualizar dependências vulneráveis, lockfile, documentação e testes para a versão 1.5.1.

## Non-goals

- Alterar permissões de shell ou introduzir sandbox de filesystem.
- Reescrever o painel `/logs` ou trocar o armazenamento local por banco de dados.
- Alterar os nomes, schemas ou semântica normal de sucesso das ferramentas MCP.

## Approach

A implementação será incremental nos módulos existentes. `server.ts` receberá uma proteção administrativa reutilizável para `/logs*`. `audit.ts` ganhará fila por caminho e caminho padrão explícito. `monitor.ts` passará a transportar a taxonomia de resultado e os IDs necessários para correlação. Os testes de auditoria e integração serão atualizados antes da implementação de cada comportamento.

## Decisions

- O painel aceitará o token estático `MCP_AUTH_TOKEN` e access tokens OAuth válidos.
- A auditoria continuará registrando uma linha por `tools/call`.
- Resultados de comando com código diferente de zero serão contabilizados como `command_nonzero_exit`, preservando a distinção de cancelamentos intencionais.
- A hidratação do histórico continuará limitada aos arquivos atual e rotacionado, com sinalização explícita de prontidão.
- A dependência `zod` será atualizada somente após validar compatibilidade com os schemas atuais.

## Acceptance criteria

- Acesso sem credencial a `/logs`, `/logs/api`, `/logs/kpis` e `/logs/stream` retorna 401.
- Um resultado `exit_code: 1` não é reportado como sucesso no KPI de confiabilidade.
- Auditoria concorrente respeita o limite de rotação sem perder linhas nem deixar a rotação dependente da ordem das promises.
- O servidor expõe o estado de hidratação do histórico e não apresenta KPI histórico como pronto antes da conclusão.
- `npm run typecheck`, `npm test` e `npm audit --omit=dev --audit-level=moderate` terminam com sucesso após as atualizações.
