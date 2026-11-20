# Monitor Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar login server-side ao painel `/logs` usando o mesmo `MCP_AUTH_TOKEN`, sem expor o token ao navegador.

**Architecture:** Reutilizar a sessão administrativa em cookie já existente em `src/server.ts`. Adicionar uma rota pública de login e uma página HTML pequena, redirecionando apenas requisições HTML sem sessão. Manter `401` para endpoints JSON e SSE sem autenticação.

**Tech Stack:** Node.js 20+, TypeScript estrito, Express, HTML/CSS/JavaScript embutidos no monitor existente, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-20-monitor-login-design.md`

## Global Constraints

- Reutilizar `MCP_AUTH_TOKEN` como credencial do formulário.
- Validar o token somente no servidor.
- Não armazenar o token em `localStorage`, `sessionStorage` ou JavaScript.
- Preservar as 17 ferramentas MCP e o fluxo atual do `/mcp`.
- Preservar o cookie `HttpOnly`, `SameSite=Strict` e TTL administrativo existente.

## Review Focus

- HTML sem sessão deve chegar à tela de login, enquanto JSON e SSE continuam recebendo `401`.
- Token inválido não pode emitir cookie nem revelar a credencial na resposta.
- Token válido deve permitir `/logs`, `/logs/kpis`, `/logs/api` e `/logs/stream` usando apenas cookie.
- Submissão de formulário deve funcionar com `application/x-www-form-urlencoded` e retornar mensagem genérica em falha.

### Task 1: Contrato de autenticação do login

**Files:**
- Modify: `src/server.ts`
- Test: `test/server.test.mjs`

- [x] Escrever testes para redirecionamento HTML, login inválido e login válido.
- [x] Executar o teste e observar a falha.
- [x] Implementar `GET /logs/login` e `POST /logs/login` com validação server-side.
- [x] Ajustar o middleware do painel para redirecionar somente HTML sem sessão.
- [x] Executar a suíte de integração do servidor.

### Task 2: Tela e fluxo de saída

**Files:**
- Modify: `src/monitor.ts`
- Modify: `src/server.ts`
- Test: `test/server.test.mjs`
- Modify: `docs/OPERACAO.md`

- [x] Escrever asserções para conteúdo da tela e link de saída.
- [x] Implementar HTML/CSS acessível com campo de token, foco inicial, mensagens genéricas e `POST` de formulário.
- [x] Adicionar `POST /logs/logout` para expirar o cookie administrativo.
- [x] Atualizar o runbook com o fluxo de login.
- [x] Executar a suíte completa.

### Task 3: Verificação final

**Files:**
- Modify: `docs/superpowers/plans/2026-11-20-monitor-login-plan.md`
- Modify: `.superpowers/sdd/2026-11-20-monitor-login-plan/progress.md`

- [x] Executar `npm run typecheck`.
- [x] Executar `npm test`.
- [x] Executar `npm audit --omit=dev --audit-level=moderate`.
- [x] Executar `git diff --check`.
