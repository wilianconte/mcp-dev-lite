# mcp-dev-agent

Servidor **MCP (Model Context Protocol)** via **Streamable HTTP** que dá a um agente de IA capacidades de desenvolvimento na VM: executar comandos, editar/mover/listar arquivos, usar `node`, `npm`, `gh`, `git` e transportar screenshots como conteúdo visual MCP nativo. **O agente decide quais comandos rodar.**

## Documentação

A documentação completa está organizada em [`docs/README.md`](docs/README.md).

- [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) — componentes, autenticação, sessões, persistência e fluxos.
- [`docs/FERRAMENTAS.md`](docs/FERRAMENTAS.md) — contrato das 16 ferramentas MCP, matriz de decisão e padrões de uso.
- [`docs/OPERACAO.md`](docs/OPERACAO.md) — runbook, variáveis de ambiente e diagnóstico.
- [`docs/SEGURANCA.md`](docs/SEGURANCA.md) — fronteiras de confiança, riscos e hardening.
- [`docs/DESENVOLVIMENTO.md`](docs/DESENVOLVIMENTO.md) — estrutura do código, testes e workflow de alteração.
- [`docs/AVALIACAO-TECNICA.md`](docs/AVALIACAO-TECNICA.md) — avaliação do estado atual e prioridades.
- [`docs/DEPLOY-CLOUDFLARE.md`](docs/DEPLOY-CLOUDFLARE.md) — exposição via Cloudflare Tunnel.
- `docs/CREDENCIAIS.local.md` — **secreto, fora do versionamento** (`.gitignore`): dados locais de produção, quando existir.

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
- **Escopo de arquivos:** sem restrição de path — o agente opera em qualquer caminho permitido ao usuário Linux do serviço (decisão de projeto). Resolve `~` e caminhos relativos.
- **Auditoria e Monitoramento em Tempo Real (`/logs`):** cada execução de ferramenta (`tools/call` validado) gera evento JSON estruturado com sessão/client, duração, argumentos sanitizados e resumo do resultado. Além de `stderr`/journald e `MCP_AUDIT_LOG_PATH`, o painel `/logs` exibe conexões ativas e transações em tempo real via SSE (`/logs/stream`).
- **Proxy:** `trust proxy=loopback` por padrão, adequado ao `cloudflared` local; outras topologias podem ajustar `MCP_TRUST_PROXY`.

## Ferramentas expostas (16 ferramentas)

| Ferramenta | O que faz |
|---|---|
| `find_files` | Localiza caminhos de arquivos rapidamente por substring ou glob (`rg --files`) sem ler o conteúdo interno, ignorando `node_modules`/`.git`/`.next`/`dist`/`build`/`coverage`. |
| `search_code` | Busca código com `ripgrep` (`rg`) nativo sem subir bash, ignorando `node_modules`/`.git`/`.next`/`dist` por padrão e com fallback automático para texto literal se o regex for inválido. |
| `read_file` | Lê texto por linhas ou por caracteres, com bloqueio automático de arquivos binários e limite de tamanho (`MCP_MAX_TEXT_FILE_BYTES`). |
| `read_files` | Lê de 1 a 20 arquivos de texto em paralelo numa única chamada, reduzindo round-trips. |
| `edit_file` | Substituição de texto exato (`old_string` → `new_string`, com `replace_all`) e diagnóstico contextual de linhas em caso de falha. |
| `multi_edit_file` | Aplica múltiplas substituições exatas no mesmo arquivo de forma atômica (se uma falhar, nenhuma é gravada), com diagnóstico contextual. |
| `write_file` | Cria ou sobrescreve um arquivo (cria diretórios pais). |
| `run_command` | Executa shell síncrono (bash) com `cwd`/`timeout` para comandos rápidos (< 15-30s). Saídas grandes recebem prévia início + fim e `artifact_id`. |
| `read_command_output` | Lê, por `offset`/`limit`, qualquer trecho de uma saída grande preservada por `run_command`, `start_command`, `search_code` ou `find_files`. |
| `start_command` | Inicia comando longo em background (builds, testes E2E/Playwright, deploys, subagentes CLI) e retorna `job_id` sem risco de timeout HTTP/Cloudflare. |
| `poll_command` | Consulta status, lê novas saídas incrementais (`offset=next_offset`) ou encerra (`kill=true`) um job iniciado por `start_command`. |
| `read_image` | Lê PNG/JPEG/GIF/WebP e retorna **ImageContent MCP nativo** + path, MIME, bytes, dimensões quando detectáveis e SHA-256. |
| `list_directory` | Lista entradas com paginação (`offset`, `limit`, `has_more`, `next_offset`) e profundidade recursiva opcional (`max_depth` de 1 a 4). |
| `move_file` | Move ou renomeia arquivo/diretório. |
| `make_directory` | `mkdir -p`. |
| `delete_path` | Exclui arquivo ou diretório (`recursive` para diretórios). |

`run_command` e `start_command` cobrem qualquer operação de shell; as ferramentas dedicadas (`find_files`, `search_code`, `read_files`, `multi_edit_file`, `read_image`) reduzem round-trips e tornam leitura, busca, edição e transporte de artefatos muito mais rápidos e confiáveis para o agente.

### Saídas grandes e screenshots

O servidor não força mais todo resultado de tool a virar uma única string. O contrato interno aceita um `CallToolResult` MCP completo, permitindo conteúdo multimodal.

- Respostas textuais continuam limitando a **prévia** a aproximadamente 30 mil caracteres para proteger o contexto, mas o conteúdo completo de `run_command` é preservado temporariamente por até 1 hora (máximo de 50 artefatos no armazenamento temporário) e pode ser recuperado com `read_command_output`.
- Quando uma prévia de comando precisa ser reduzida, ela preserva **início e fim** em vez de apenas cortar o final.
- `read_file` informa tamanho total e próximo offset; arquivos minificados podem ser navegados com `char_offset`/`char_limit`.
- `read_image` envia os bytes como bloco `type: "image"`; não passe imagens via `base64` em `run_command`, porque isso desperdiça contexto e perde a semântica multimodal.
- O limite padrão para uma imagem é 10 MiB e pode ser ajustado com `MCP_MAX_IMAGE_BYTES`.
- `run_command` usa grupo de processo próprio: em timeout, shell e descendentes são encerrados juntos. O buffer de segurança padrão foi elevado para 50 MiB e pode ser configurado com `MCP_COMMAND_MAX_BUFFER_BYTES`; se esse limite for atingido, o resultado informa explicitamente `output_limit_exceeded: true`.

Para auditoria de UX, o fluxo recomendado é: gerar screenshots no projeto (por exemplo com Playwright) → localizar o arquivo → chamar `read_image` → analisar a imagem diretamente no modelo.

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

Desenvolvimento com reload: `npm run dev` (também precisa de `MCP_AUTH_TOKEN`). Testes locais: `npm test`.

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
5. As 16 ferramentas aparecem para o agente, que passa a decidir sozinho quando chamar `find_files`, `search_code`, `read_files`, `multi_edit_file`, `run_command`, `start_command`, etc.

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

- Trate o `MCP_AUTH_TOKEN` como credencial equivalente às permissões do usuário Linux que executa o serviço. Rotacione-o periodicamente.
- Rode o processo com um **usuário de baixo privilégio** dedicado ao desenvolvimento, não como `root`.
- Prefira uma **VM descartável/isolada** por projeto; não aponte para máquinas com dados sensíveis de outros sistemas.
- Sempre atrás de **TLS**; nunca exponha a porta HTTP crua na internet.
- A auditoria de `tools/call` já é habilitada por padrão em `stderr`/journald; defina retenção adequada e use `MCP_AUDIT_LOG_PATH` apenas quando precisar de JSONL em arquivo.
