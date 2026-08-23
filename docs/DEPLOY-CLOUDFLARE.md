# Deploy do mcp-dev-agent via Cloudflare Tunnel

Expõe o servidor MCP com HTTPS público e estável, sem abrir portas na VM.

## Visão geral

```
Copilot Studio ──HTTPS──► borda Cloudflare ──túnel de saída──► cloudflared (VM) ──► 127.0.0.1:3000 (MCP)
```

O `cloudflared` abre uma conexão **de saída** para a Cloudflare; nenhuma porta de entrada é aberta na VM.

## Passo 0 — Garantir o `cloudflared`

Verifique se já existe na máquina:

```bash
cloudflared --version
```

Se o comando não for encontrado, instale. Sem `sudo` (binário no diretório do usuário):

```bash
mkdir -p ~/.local/bin && curl -fsSL -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x ~/.local/bin/cloudflared
```

`~/.local/bin` entra no `PATH` no próximo login (via `~/.profile`); na sessão atual, use o caminho completo ou `export PATH="$HOME/.local/bin:$PATH"`. Para outras arquiteturas, troque `linux-amd64` (ex.: `linux-arm64`) — ou use o pacote `.deb`/repositório oficial da Cloudflare se preferir instalação de sistema.

O mesmo vale para o **Node.js** (`node --version`, requer >= 20): se não houver, instale antes de `npm ci`.

## Passo 1 — Login (você precisa fazer, uma vez)

Provisionar um túnel cria recursos na **sua** conta Cloudflare, então exige a **sua** autenticação. No terminal desta sessão, rode com o prefixo `!`:

```
! cloudflared tunnel login
```

Isso abre o browser, você escolhe o domínio (zona) que já tem na Cloudflare e grava `~/.cloudflared/cert.pem`. Requer um domínio ativo na sua conta Cloudflare.

> Sem domínio próprio e só querendo testar? Pule para o "Modo rápido" no fim.

## Passo 2 — Provisionar o túnel (automatizado)

Depois do login, rode o script pronto:

```bash
./scripts/provision-cloudflare.sh mcp.seudominio.com
```

Ele cria o túnel `mcp-dev-agent`, gera `~/.cloudflared/config.yml` (ingress → `http://127.0.0.1:3000`) e cria o registro DNS `mcp.seudominio.com`.

## Passo 3 — Subir os dois serviços

Servidor MCP (systemd):

```bash
# 1) crie o .env com o token
printf 'MCP_AUTH_TOKEN=%s\nPORT=3000\nHOST=127.0.0.1\n' "$(openssl rand -hex 32)" > .env
chmod 600 .env
npm ci && npm run build

# 2) instale o serviço (ajuste __RUN_USER__ e __REPO_DIR__ no arquivo antes)
sudo cp deploy/mcp-dev-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mcp-dev-agent
```

Cloudflared (systemd):

```bash
sudo cloudflared --config ~/.cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
```

## Passo 4 — Validar

```bash
curl -X POST https://mcp.seudominio.com/mcp \
  -H "Authorization: Bearer $(grep MCP_AUTH_TOKEN .env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}'
```

Deve retornar `serverInfo` e um header `Mcp-Session-Id`.

## Passo 5 — Conectar no Copilot Studio

URL do connector: `https://mcp.seudominio.com/mcp`, autenticação por header `Authorization: Bearer <MCP_AUTH_TOKEN>`. Detalhes em [`../README.md`](../README.md#conectando-no-copilot-studio).

## Modo rápido (teste, sem domínio/conta)

Gera uma URL `*.trycloudflare.com` efêmera:

```bash
export MCP_AUTH_TOKEN=$(openssl rand -hex 32); PORT=3000 npm start &
cloudflared tunnel --url http://127.0.0.1:3000
```

Use a URL impressa + `/mcp`. **Efêmera e sem SLA — só para teste, nunca produção.**
