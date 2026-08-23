# Arquitetura

## Objetivo

O `mcp-dev-agent` é um servidor MCP executado dentro de uma VM de desenvolvimento. Ele permite que um cliente MCP autorizado execute comandos, manipule arquivos e leia artefatos visuais diretamente nessa VM.

A aplicação privilegia autonomia do agente. Não existe sandbox de comandos nem restrição de diretórios no código atual; os limites efetivos são as permissões do usuário do sistema operacional que executa o processo.

## Componentes

```text
Cliente MCP
  |  HTTPS
  |  Authorization: Bearer <token>
  v
Cloudflare Tunnel / reverse proxy
  |
  |  HTTP em loopback
  v
Express (src/server.ts)
  |-- endpoints OAuth
  |-- /mcp (Streamable HTTP)
  |-- /health
  |
  +--> DevAgentOAuthProvider (src/oauth.ts)
  |      |-- clients e tokens persistidos
  |      `-- aprovações e authorization codes em memória
  |
  `--> McpServer
         `--> tools[] (src/tools.ts)
                |-- shell / filesystem
                |-- leitura de imagem
                `-- armazenamento temporário de saídas grandes
                       `--> src/output-store.ts
```

## Módulos

### `src/server.ts`

Responsável por:

- inicialização do Express;
- registro dos endpoints OAuth fornecidos pelo SDK MCP;
- autenticação do endpoint `/mcp`;
- criação e gerenciamento das sessões Streamable HTTP;
- registro das ferramentas MCP;
- endpoint `/health`.

Cada sessão MCP recebe uma instância de `McpServer`. Os transportes ativos são indexados pelo header `Mcp-Session-Id` em um `Map` em memória.

### `src/oauth.ts`

Implementa um provider OAuth 2.1 self-hosted com:

- Dynamic Client Registration;
- authorization code;
- PKCE validado pelo handler do SDK MCP;
- refresh token com rotação;
- revogação de tokens;
- tela local de aprovação protegida por senha.

Estado persistente:

- clients registrados;
- access tokens;
- refresh tokens.

Estado somente em memória:

- autorizações pendentes;
- authorization codes;
- contador de falhas de senha por IP.

### `src/tools.ts`

Define o catálogo de ferramentas e seus schemas Zod. Os handlers retornam `CallToolResult`, permitindo resultados textuais e multimodais.

Os grupos principais são:

- execução de shell;
- leitura e escrita de filesystem;
- paginação de conteúdo;
- leitura de screenshots como `ImageContent` MCP.

### `src/output-store.ts`

Armazena temporariamente em disco a saída completa de comandos cujo resultado ultrapassa a prévia textual.

Características atuais:

- diretório: `${TMPDIR}/mcp-dev-agent-output`;
- arquivos com permissão `0600`;
- diretório com permissão `0700`;
- TTL de 1 hora;
- máximo de 50 artefatos;
- identificação por UUID.

## Fluxo de autenticação

### Token estático

1. Cliente envia `Authorization: Bearer <MCP_AUTH_TOKEN>`.
2. `checkAuth` normaliza o header.
3. Se o token coincidir com `MCP_AUTH_TOKEN`, a chamada é aceita.

Esse fluxo é usado principalmente por integrações que suportam Bearer token direto.

### OAuth

1. Cliente descobre metadata em `/.well-known/*`.
2. Cliente é registrado via DCR.
3. O fluxo de autorização abre a tela de aprovação.
4. O usuário informa `OAUTH_APPROVAL_PASSWORD`.
5. É emitido um authorization code de uso único.
6. O endpoint de token valida PKCE por meio do SDK MCP.
7. São emitidos access token e refresh token.
8. Chamadas futuras ao `/mcp` usam o access token.

TTL atuais:

- access token: 2 horas;
- refresh token: 30 dias;
- authorization code: 10 minutos;
- autorização pendente: 10 minutos.

## Fluxo de uma sessão MCP

1. O cliente chama `POST /mcp` com um request `initialize` sem `Mcp-Session-Id`.
2. O servidor cria um `StreamableHTTPServerTransport`.
3. O SDK gera um UUID para a sessão.
4. O transporte é guardado em memória.
5. O cliente reenvia `Mcp-Session-Id` nas chamadas posteriores.
6. `GET /mcp` atende o canal de eventos; `DELETE /mcp` encerra a sessão.
7. No fechamento do transporte, a sessão é removida do `Map`.

### Consequência arquitetural

Sessões são locais ao processo. Reiniciar o processo encerra todas as sessões e, sem afinidade de sessão ou armazenamento compartilhado, múltiplas réplicas não podem atender a mesma sessão de forma intercambiável.

## Fluxo de execução de comando

```text
run_command
  |
  +--> spawn /bin/bash -c <command>
  |      |-- cwd configurável
  |      |-- timeout máximo de 10 min
  |      `-- grupo de processos próprio
  |
  +--> captura stdout/stderr
  |
  +--> se timeout ou limite de buffer:
  |      `-- SIGTERM e depois SIGKILL no grupo
  |
  `--> resultado
         |-- até ~30k chars: resposta direta
         `-- acima disso:
                |-- preview início + fim
                `-- conteúdo completo no output-store
```

## Fluxo de screenshot

```text
Projeto / Playwright / navegador
  |
  `--> arquivo PNG/JPEG/GIF/WebP
          |
          `--> read_image
                 |-- valida tipo e tamanho
                 |-- calcula SHA-256
                 `-- retorna ImageContent MCP nativo
```

Esse fluxo evita transportar base64 como texto de shell e preserva a semântica multimodal para o cliente/modelo.

## Persistência e ciclo de vida

| Dado | Local | Persistente após restart? |
|---|---|---|
| Clients OAuth | `data/oauth-state.json` | Sim |
| Access tokens OAuth | `data/oauth-state.json` | Sim |
| Refresh tokens OAuth | `data/oauth-state.json` | Sim |
| Authorization codes | memória | Não |
| Autorizações pendentes | memória | Não |
| Sessões MCP | memória | Não |
| Saídas grandes | diretório temporário | Pode sobreviver ao processo, mas expira por TTL |
| Auditoria | stderr/journald e opcionalmente `MCP_AUDIT_LOG_PATH` | Conforme retenção do coletor/arquivo |

## Limites arquiteturais atuais

- Um único processo mantém todo o estado de sessão MCP.
- Não existe fila nem controle de concorrência por ferramenta.
- Não existe sandbox ou allowlist de comandos.
- Não existe restrição de path.
- A auditoria de `tools/call` é local ao processo e não possui backend central próprio.
- O armazenamento OAuth é local ao filesystem e não serve como backend compartilhado para múltiplas réplicas.
- O Express usa `trust proxy=loopback` por padrão, adequado ao cloudflared local; deployments com outra topologia devem ajustar `MCP_TRUST_PROXY`.

Consulte [`SEGURANCA.md`](./SEGURANCA.md) para o impacto e os controles recomendados.
