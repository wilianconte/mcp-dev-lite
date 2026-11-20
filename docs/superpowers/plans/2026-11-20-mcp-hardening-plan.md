# MCP Hardening and KPI Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Corrigir exposição administrativa, métricas subestimadas e persistência frágil sem alterar o contrato das ferramentas MCP.

**Architecture:** Reutilizar `server.ts`, `audit.ts`, `monitor.ts` e os testes existentes. Adicionar uma camada pequena de autenticação administrativa, uma fila de escrita por arquivo e uma taxonomia estruturada de resultados.

**Tech Stack:** Node.js 20+, TypeScript estrito, Express, MCP SDK, Zod, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-20-mcp-hardening-design.md`

## Global Constraints

- Preservar as 17 ferramentas MCP e seus schemas públicos.
- Aceitar Bearer estático e OAuth válido nas rotas administrativas.
- Manter redaction e limites existentes de auditoria.
- Não alterar a execução arbitrária de shell nesta etapa.

## Review Focus

- Requisições sem credencial às quatro rotas administrativas devem ser rejeitadas.
- Saídas `exit_code` não zero devem aparecer na taxonomia de resultados.
- Escritas concorrentes e rotação devem manter eventos íntegros.
- Histórico com versões antigas deve continuar sendo agregado.
- Testes antigos de versão devem refletir `1.5.1`.

### Task 1: Proteção do painel administrativo

**Files:**
- Modify: `src/server.ts`
- Modify: `src/monitor.ts` somente se necessário para montagem
- Test: `test/server.test.mjs`

- [x] Escrever testes para 401 sem credencial e 200 com token estático nas quatro rotas.
- [x] Executar os testes e observar a falha.
- [x] Implementar middleware administrativo reutilizando `checkAuth`.
- [x] Executar a suíte de servidor.

### Task 2: Taxonomia de resultados e correlação KPI

**Files:**
- Modify: `src/audit.ts`
- Modify: `src/monitor.ts`
- Test: `test/audit.test.mjs`

- [x] Escrever testes para `exit_code: 1`, timeout, kill e sucesso.
- [x] Executar os testes e observar a falha.
- [x] Adicionar classificação estruturada sem quebrar o resumo existente.
- [x] Transportar session, client, request e job IDs para correlação de edição e polling.
- [x] Executar os testes de auditoria.

### Task 3: Persistência e rotação seguras

**Files:**
- Modify: `src/audit.ts`
- Modify: `src/server.ts`
- Modify: `docs/OPERACAO.md`
- Test: `test/audit.test.mjs`

- [x] Escrever teste de caminho padrão e gravações concorrentes com rotação.
- [x] Executar os testes e observar a falha.
- [x] Implementar fila por caminho e estado de hidratação.
- [x] Atualizar documentação e validar hidratação após startup.
- [x] Executar os testes de auditoria.

### Task 4: Dependências e higiene de release

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/FERRAMENTAS.md`
- Modify: `docs/ARQUITETURA.md`
- Modify: `docs/AVALIACAO-TECNICA.md`
- Modify: `docs/RECOMENDACAO.md`
- Modify: `test/audit.test.mjs`
- Modify: `test/server.test.mjs`

- [x] Atualizar dependências para versões corrigidas e executar build.
- [x] Atualizar referências de versão e expectativas dos testes.
- [x] Executar typecheck, testes completos e audit.
