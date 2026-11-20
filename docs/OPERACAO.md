# Operação

Este documento é o runbook do `mcp-dev-agent`.

## Pré-requisitos

- Linux/WSL/VM com `/bin/bash`;
- Node.js 20 ou superior;
- npm;
- acesso às ferramentas que o agente deverá usar (`git`, `gh`, `npx`, compiladores etc.);
- HTTPS público quando o cliente MCP estiver fora da VM.

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Finalidade |
|---|---|---|---|
| `MCP_AUTH_TOKEN` | Sim | — | Credencial estática do endpoint MCP e fallback da senha OAuth. |
| `PORT` | Não | `3000` | Porta HTTP. |
| `HOST` | Não | `0.0.0.0` | Endereço de bind. Em produção atrás de túnel/proxy, use `127.0.0.1`. |
| `PUBLIC_URL` | Produção/OAuth | `http://localhost:<PORT>` | Issuer OAuth e base pública do resource server. |
| `OAUTH_APPROVAL_PASSWORD` | Recomendado | `MCP_AUTH_TOKEN` | Senha da tela de aprovação OAuth. |
| `MCP_MAX_IMAGE_BYTES` | Não | `10485760` | Tamanho máximo de imagem lida por `read_image`. |
| `MCP_MAX_TEXT_FILE_BYTES` | Não | `10485760` | Tamanho máximo de arquivo de texto lido por `read_file` / `read_files`. |
| `MCP_COMMAND_MAX_BUFFER_BYTES` | Não | `52428800` | Máximo combinado capturado de stdout/stderr por comando. |
| `MCP_REQUEST_BODY_LIMIT` | Não | `16mb` | Limite do corpo JSON aceito em `POST /mcp`, aplicado depois da autenticação. |
| `MCP_TRUST_PROXY` | Não | `loopback` | Proxies confiáveis pelo Express; `loopback` é o recomendado com cloudflared local. |
| `MCP_AUDIT_LOG_PATH` | Não | `./data/audit.jsonl` | Arquivo JSONL para auditoria de `tools/call`. |
| `MCP_AUDIT_MAX_BYTES` | Não | `20971520` | Limite em bytes antes de rotacionar `audit.jsonl` para `audit.jsonl.1` (padrão 20 MiB). |
| `MCP_AUDIT_STDERR` | Não | `true` | Envia eventos estruturados também para stderr/journald. |
| `MCP_LOG_PROTOCOL_EVENTS` | Não | `false` | Quando `true`, inclui handshakes de protocolo (`mcp.initialize`, `mcp.sse_open`, `mcp.tools_list`) na lista de transações em `/logs`. |
| `MCP_DATA_DIR` | Não | `./data` relativo ao projeto | Diretório base privado para estado OAuth, auditoria e outros estados locais. |
| `MCP_JOB_STORE_DIR` | Não | `/tmp/mcp-dev-agent-jobs` | Diretório privado para snapshots de jobs em segundo plano. |
| `MCP_COMMAND_ENV_MODE` | Não | `full` | `full` preserva o ambiente do processo. `sanitized` remove variáveis com nomes de token, senha, segredo, chave, credencial, cookie ou autenticação. |
| `MCP_MONITOR_LOGIN_MAX_ATTEMPTS` | Não | `10` | Tentativas de login do painel por IP em uma janela de 15 minutos. |
| `MCP_RUN_USER` | Não | `root` | Usuário usado pelo script de renderização do unit systemd. O unit precisa ser regerado após a alteração. |

Valores de tamanho são em bytes.

## Instalação local

```bash
npm ci
npm run build
```

Crie `.env` a partir de `.env.example` ou exporte as variáveis no ambiente do processo.

Exemplo de desenvolvimento:

```bash
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
export HOST=127.0.0.1
export PORT=3000
npm run dev
```

O script `npm run dev` usa `tsx watch`.

## Produção

O fluxo recomendado é:

```text
Internet -> HTTPS/Cloudflare -> 127.0.0.1:3000 -> mcp-dev-agent
```

Compile antes de iniciar:

```bash
npm ci
npm run build
npm start
```

O template systemd está em `deploy/mcp-dev-agent.service`. Gere uma unidade configurada com `MCP_REPO_DIR`, `MCP_ENV_FILE`, `MCP_RUN_USER`, `MCP_NODE_BIN`, `MCP_PORT`, `MCP_PUBLIC_URL` e `MCP_DATA_DIR` usando `scripts/render-systemd-unit.sh`.

```bash
MCP_REPO_DIR=/root/repos/mcp-dev-lite \
MCP_ENV_FILE=/root/repos/mcp-dev/.env \
MCP_RUN_USER=root \
MCP_NODE_BIN=/root/.nvm/versions/node/v22.23.1/bin \
MCP_PORT=3001 \
MCP_PUBLIC_URL=https://mcp-lite.criaelo.com \
MCP_DATA_DIR=/root/repos/mcp-dev-lite/data \
scripts/render-systemd-unit.sh /tmp/mcp-dev-lite-agent.service
sudo install -m 0644 /tmp/mcp-dev-lite-agent.service /etc/systemd/system/mcp-dev-lite-agent.service
sudo systemctl daemon-reload
sudo systemctl restart mcp-dev-lite-agent.service
```

O guia de túnel está em [`DEPLOY-CLOUDFLARE.md`](./DEPLOY-CLOUDFLARE.md).

## Health check

`GET /health` não exige autenticação.

Exemplo esperado:

```json
{
  "status": "ok",
  "version": "1.5.1"
}
```

Esse endpoint confirma que o processo HTTP está respondendo. Ele não enumera ferramentas nem valida execução de shell, escrita em disco, OAuth ou conectividade do túnel.

## Validação antes de publicar

Execute:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:coverage
```

Depois valide:

```bash
curl http://127.0.0.1:3000/health
```

Por fim, faça um handshake MCP autenticado conforme o exemplo do README.

## Logs e Painel em Tempo Real (`/logs`)

O servidor disponibiliza uma interface web em `/logs`. Ao abrir a rota no navegador sem sessão, o servidor redireciona para `/logs/login`, onde o operador informa o mesmo valor de `MCP_AUTH_TOKEN`. A validação ocorre no servidor e a sessão é mantida por cookie `HttpOnly` temporário. O token não é armazenado no navegador. Também é possível autenticar chamadas técnicas com `Authorization: Bearer`. O cookie permite que o `EventSource` do painel mantenha o SSE sem expor o Bearer ao JavaScript. O painel possui duas abas principais:
- **Conexões**: sessões MCP ativas, cliente conectado, IP, contadores de chamadas/erros e atividade em andamento;
- **Transações (Logs em Tempo Real)**: stream SSE (`/logs/stream`) e histórico (`/logs/api`) com filtros de busca, status, ferramenta, sessão e modal de detalhes completos da requisição/resposta.

O botão **Sair** envia `POST /logs/logout`, invalida a sessão em memória e redireciona para a tela de login.

Além disso, a aplicação escreve em stdout/stderr:

- inicialização e lista de ferramentas;
- registro de clientes OAuth;
- aprovações OAuth;
- falhas de autenticação;
- falhas de senha da tela de aprovação;
- eventos estruturados `[audit]` para cada execução de ferramenta validada.

Com systemd:

```bash
journalctl -u mcp-dev-agent -f
journalctl -u mcp-dev-agent --since today
```

A auditoria é persistida por padrão em `./data/audit.jsonl` e enviada ao stderr/journald. Configure `MCP_AUDIT_LOG_PATH` para escolher outro caminho ou use `false` para desativar a cópia em arquivo. Os registros são JSON Lines e têm redaction de campos/padrões sensíveis.

## Diagnóstico rápido

### Processo não inicia

Verifique:

```bash
node --version
npm run typecheck
npm run build
```

Confirme se `MCP_AUTH_TOKEN` está definido. Sem ele, a aplicação encerra intencionalmente no startup.

### `/health` não responde

```bash
ss -ltnp | grep 3000
systemctl status mcp-dev-agent
journalctl -u mcp-dev-agent -n 100 --no-pager
```

Confirme `HOST` e `PORT`.

### Cliente recebe 401

Verifique:

- presença do header `Authorization`;
- token correto;
- expiração do access token OAuth;
- logs `[auth] 401`;
- `PUBLIC_URL` compatível com a URL pública usada pelo cliente OAuth.

O servidor tolera `Bearer` duplicado no header para compatibilidade com conectores que adicionam o esquema automaticamente.

### Cliente recebe “Sessão inválida”

Faça um novo `initialize`. Isso ocorre quando:

- `Mcp-Session-Id` está ausente em uma chamada posterior;
- o processo reiniciou;
- a sessão foi encerrada;
- o request foi encaminhado para outra réplica sem estado compartilhado.

### `run_command` termina por timeout

A resposta apresenta `exit_code: timeout`. O servidor envia sinais ao grupo do processo para evitar descendentes órfãos.

Aumente `timeout_ms` apenas quando necessário; o máximo do schema é 600000 ms.

### `run_command` atinge limite de saída

A resposta apresenta `output_limit_exceeded: true`. Reduza a verbosidade do comando ou ajuste `MCP_COMMAND_MAX_BUFFER_BYTES` com cautela.

### Saída grande foi resumida

Procure `artifact_id` na resposta e use `read_command_output` até `has_more=false`.

### `read_image` rejeita arquivo

Verifique:

- formato PNG/JPEG/GIF/WebP;
- tamanho abaixo de `MCP_MAX_IMAGE_BYTES`;
- path correto;
- permissões do usuário do serviço.

## Estado OAuth

Arquivo:

```text
data/oauth-state.json
```

Ele é ignorado pelo Git e deve permanecer com permissão restrita.

Apagar esse arquivo e reiniciar o processo revoga na prática os clients/tokens persistidos e exige nova autorização.

Antes de qualquer backup desse arquivo, trate-o como segredo: ele contém credenciais OAuth ativas em formato recuperável pelo processo.

## Saídas temporárias

Saídas grandes são armazenadas em:

```text
${TMPDIR}/mcp-dev-agent-output
```

O servidor remove artefatos com mais de 1 hora e limita o conjunto a 50 arquivos. O diretório é privado ao usuário do processo.

## Reinício seguro

1. confirme que não há trabalho crítico em andamento;
2. rode typecheck/testes quando houver mudança de código;
3. reinicie o serviço;
4. valide `/health`;
5. valide uma conexão MCP;
6. espere que sessões MCP anteriores precisem ser reinicializadas.

Com systemd:

```bash
sudo systemctl restart mcp-dev-agent
systemctl status mcp-dev-agent --no-pager
```

## Checklist operacional

- [ ] processo roda como usuário de baixo privilégio;
- [ ] `HOST=127.0.0.1` quando houver proxy/túnel local;
- [ ] HTTPS público válido;
- [ ] `MCP_AUTH_TOKEN` forte e fora do repositório;
- [ ] `OAUTH_APPROVAL_PASSWORD` separado do token estático;
- [ ] `.env` e `data/oauth-state.json` com acesso restrito;
- [ ] typecheck e testes verdes;
- [ ] `/health` responde;
- [ ] handshake MCP funciona;
- [ ] logs do serviço estão acessíveis.
