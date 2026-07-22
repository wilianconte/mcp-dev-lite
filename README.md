# mcp-dev-agent

Servidor **MCP (Model Context Protocol)** via **Streamable HTTP** que dá a um agente de IA — consumido por um agente do **Microsoft Copilot Studio** — as mesmas capacidades de desenvolvimento que um agente Claude Code tem nesta VM: executar comandos, editar/mover/listar arquivos e usar `node`, `npm`, `gh`, `git`, etc. **O agente decide quais comandos rodar.**

## Documentação

- [`docs/RECOMENDACAO.md`](docs/RECOMENDACAO.md) — recomendações de arquitetura e próximos passos antes de produção.
- [`docs/DEPLOY-CLOUDFLARE.md`](docs/DEPLOY-CLOUDFLARE.md) — expor via Cloudflare Tunnel (HTTPS público, sem abrir portas).
- `docs/CREDENCIAIS.local.md` — **secreto, fora do versionamento** (`.gitignore`): URL, token e dados do túnel em produção (`mcp.criaelo.com`).

## Arquitetura

```
Copilot Studio (nuvem)
        │  HTTPS + Bearer token
        ▼
[ Reverse proxy / túnel com TLS ]   ← obrigatório: Copilot Studio exige HTTPS público
        │
        ▼
mcp-dev-agent  (Express + Streamable HTTP, porta 3000)
        │  child_process / fs
        ▼
  VM de desenvolvimento  (node, npm, gh, git, arquivos das aplicações)
```

- **Transporte:** Streamable HTTP (endpoint único `POST/GET/DELETE /mcp`), que é o modo que o Copilot Studio consome MCP.
- **Auth (duas formas, ambas aceitas no `/mcp`):**
  - **Bearer token estático** via header `Authorization` (variável `MCP_AUTH_TOKEN`) — usado pelo Copilot Studio.
  - **OAuth 2.1** conforme a spec de autorização do MCP (Dynamic Client Registration, authorization code + PKCE, refresh token) — exigido pelo ChatGPT. Endpoints: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`, `/authorize`, `/token`, `/register`, `/revoke`. A aprovação pede a senha `OAUTH_APPROVAL_PASSWORD` (fallback: `MCP_AUTH_TOKEN`). Clients e tokens ficam em `data/oauth-state.json` (fora do versionamento, `chmod 600`); implementação em `src/oauth.ts`.
- **Escopo de arquivos:** sem restrição de path — o agente opera em qualquer caminho da VM (decisão de projeto). Resolve `~` e caminhos relativos.

## Ferramentas expostas

| Ferramenta | O que faz |
|---|---|
| `run_command` | Executa qualquer comando de shell (bash) com `cwd` e `timeout` opcionais. Cobre `node`, `npm`, `npx`, `gh`, `git`, build, testes. Retorna stdout/stderr/exit code. |
| `read_file` | Lê um arquivo (opcionalmente uma faixa de linhas). |
| `write_file` | Cria ou sobrescreve um arquivo (cria diretórios pais). |
| `edit_file` | Substituição de texto exato (`old_string` → `new_string`, com `replace_all`). |
| `list_directory` | Lista entradas de um diretório com o tipo de cada uma. |
| `move_file` | Move ou renomeia arquivo/diretório. |
| `make_directory` | `mkdir -p`. |
| `delete_path` | Exclui arquivo ou diretório (`recursive` para diretórios). |

`run_command` sozinho já cobre tudo; as ferramentas de arquivo existem porque são mais confiáveis e legíveis para o agente do que montar comandos de shell.

## Rodando

```bash
npm install
npm run build

# gere um token forte e exporte antes de iniciar
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
export PORT=3000
# producao: URL publica HTTPS (issuer OAuth) e senha da tela de aprovacao
export PUBLIC_URL=https://seu-host
export OAUTH_APPROVAL_PASSWORD=uma-senha-forte
npm start
```

Desenvolvimento com reload: `npm run dev` (também precisa de `MCP_AUTH_TOKEN`).

Health check (sem auth): `GET /health` → `{ "status": "ok", "tools": [...] }`.

### Teste rápido do handshake

```bash
curl -X POST http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}'
```

O header de resposta `Mcp-Session-Id` deve ser reenviado nas chamadas seguintes (`tools/list`, `tools/call`).

## Expondo com HTTPS (necessário para o Copilot Studio)

O Copilot Studio (nuvem) só alcança endpoints **HTTPS públicos**. Coloque o servidor atrás de TLS. Opções:

- **Reverse proxy** (nginx/Caddy) com certificado, encaminhando para `http://127.0.0.1:3000`.
- **Túnel** para expor rapidamente: `cloudflared`, `ngrok`, ou Azure Application Gateway / Front Door se a VM for Azure.

Mantenha o servidor MCP ouvindo em `127.0.0.1` quando houver proxy na frente, para não expor a porta HTTP crua.

## Conectando no Copilot Studio

O Copilot Studio consome MCP através de uma **tool/custom connector** apontando para o endpoint Streamable HTTP:

1. No **Copilot Studio**, abra seu agente → **Tools** → **Add a tool** → **New tool** → **Model Context Protocol**.
   (Alternativamente, **Power Apps → Custom connectors** e importe a spec abaixo.)
2. **Server URL:** a URL HTTPS pública que aponta para `/mcp` (ex.: `https://seu-host/mcp`).
3. **Autenticação:** tipo **API Key** / cabeçalho, com header `Authorization` e valor `Bearer <seu MCP_AUTH_TOKEN>`. Guarde o token no cofre/variável de ambiente do connector, nunca no prompt.
4. Salve e **publique** o connector; adicione a tool ao agente.
5. As 8 ferramentas aparecem para o agente, que passa a decidir sozinho quando chamar `run_command`, `edit_file`, etc.

> Observação: o suporte a MCP no Copilot Studio evolui rápido. Se a UI não oferecer MCP nativo na sua região/licença, crie um **custom connector** com uma spec OpenAPI que descreva o endpoint `/mcp` (Streamable HTTP) e o header `Authorization`.

## Conectando no ChatGPT

O ChatGPT exige **OAuth** (não aceita Bearer token estático) e requer developer mode (Plus/Pro) ou plano Business/Enterprise:

1. **Settings → Connectors → Create** (com developer mode habilitado em Settings → Connectors → Advanced).
2. **MCP Server URL:** `https://seu-host/mcp` — **Authentication:** OAuth.
3. O ChatGPT descobre os endpoints via `/.well-known/*`, registra-se sozinho (DCR) e abre a **tela de aprovação**: informe a `OAUTH_APPROVAL_PASSWORD`.
4. Pronto — access tokens duram 2 h e são renovados automaticamente via refresh token (30 dias, com rotação).

Para revogar o acesso do ChatGPT: apague `data/oauth-state.json` e reinicie o serviço (ou use `/revoke`).

## Segurança — leia antes de produção

Este servidor **executa comandos arbitrários** na VM. Consequências:

- Trate o `MCP_AUTH_TOKEN` como credencial de acesso root à VM. Rotacione-o periodicamente.
- Rode o processo com um **usuário de baixo privilégio** dedicado ao desenvolvimento, não como `root`.
- Prefira uma **VM descartável/isolada** por projeto; não aponte para máquinas com dados sensíveis de outros sistemas.
- Sempre atrás de **TLS**; nunca exponha a porta HTTP crua na internet.
- Considere logs de auditoria dos comandos recebidos se precisar de rastreabilidade.
