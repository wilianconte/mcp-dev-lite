#!/usr/bin/env node
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools.js";
import { DevAgentOAuthProvider } from "./oauth.js";
import { auditLogPath, auditToolCall } from "./audit.js";
import { McpMonitor } from "./monitor.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
// URL publica (issuer OAuth e resource do MCP). Em producao: https://mcp.criaelo.com
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const SESSION_IDLE_TTL_MS = Number(process.env.MCP_SESSION_IDLE_TTL_MS ?? 2 * 60 * 1000);
const MAX_IDLE_SESSIONS = Number(process.env.MCP_MAX_IDLE_SESSIONS ?? 100);
const LOG_PROTOCOL_EVENTS = process.env.MCP_LOG_PROTOCOL_EVENTS?.toLowerCase() === "true";

if (!AUTH_TOKEN) {
  console.error(
    "ERRO: defina a variavel de ambiente MCP_AUTH_TOKEN com um token secreto antes de iniciar.\n" +
      "Ex: MCP_AUTH_TOKEN=$(openssl rand -hex 32) npm start",
  );
  process.exit(1);
}

// Senha exigida na tela de aprovacao OAuth (fallback: o proprio MCP_AUTH_TOKEN).
const APPROVAL_PASSWORD = process.env.OAUTH_APPROVAL_PASSWORD ?? AUTH_TOKEN;
const DATA_DIR = process.env.MCP_DATA_DIR
  ? path.resolve(process.env.MCP_DATA_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

const monitor = new McpMonitor();
void monitor.hydrateFromAuditFile(auditLogPath());

const oauthProvider = new DevAgentOAuthProvider(DATA_DIR, APPROVAL_PASSWORD, monitor);
const mcpUrl = new URL("/mcp", PUBLIC_URL);

interface AuditRequestContext {
  remoteIp?: string;
  clientId?: string;
}

const toolDescriptors = tools.map((tool) => ({
  tool,
  config: {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.schema,
  },
}));

/** Cria uma instancia do servidor MCP com todas as ferramentas registradas. */
function buildServer(context: AuditRequestContext = {}): McpServer {
  const server = new McpServer(
    { name: "mcp-dev-agent", version: "1.4.0" },
    {
      instructions:
        "Servidor de desenvolvimento na VM (16 ferramentas). Siga estas diretrizes de escolha de ferramentas para maxima performance:\n" +
        "1. LOCALIZACAO DE ARQUIVOS E DIRETORIOS: Use find_files para localizar arquivos por nome, substring ou glob, aceitando alternancia com '|' (ex.: pattern='sidebar', pattern='*inbox*|*media*|*.spec.ts', max_depth=1..10) e list_directory (com max_depth de 1 a 4) para explorar a estrutura de pastas. Nunca use find/ls via run_command.\n" +
        "2. BUSCA EM CODIGO: Use SEMPRE search_code (ripgrep nativo) para buscar texto/regex dentro de arquivos. Passe o path mais especifico possivel (ex.: '/root/repos/app/src') e use fixed_strings=true ao buscar trechos literais com (), {}, [] ou $.\n" +
        "3. LEITURA DE ARQUIVOS: Para 1 arquivo use read_file; para 2 a 20 arquivos (ou 2 ou mais faixas offset/limit distantes do mesmo arquivo grande) use read_files em lote (leitura paralela). Evite cat/head/tail/sed via run_command. Arquivos binarios sao bloqueados automaticamente.\n" +
        "4. EDICAO DE ARQUIVOS: Para alterar 1 trecho use edit_file; para alterar 2 ou mais trechos no mesmo arquivo use multi_edit_file (atomico); para criar/sobrescrever o arquivo inteiro use write_file.\n" +
        "5. COMANDOS CURTOS VS LONGOS: Use run_command apenas para operacoes rapidas (<30s, como git status, git diff, gh pr view). Para builds, suites de teste, deploys, instalacoes, gh run watch, pipelines encadeados (lint && build && test) ou invocacao de subagentes CLI (agy), use SEMPRE start_command seguido de poll_command passando offset=next_offset da chamada anterior para ler apenas novas linhas.\n" +
        "6. SAIDAS GRANDES E IMAGENS: Saidas >30k chars geram artifact_id para leitura paginada via read_command_output. Para screenshots/imagens (PNG/JPEG/GIF/WebP), use read_image (ImageContent MCP nativo).",
    },
  );

  for (const { tool, config } of toolDescriptors) {
    server.registerTool(
      tool.name,
      config,
      async (args: Record<string, unknown>, extra) => {
        const startedAtMs = Date.now();
        const resolvedClientId = context.clientId ?? extra.authInfo?.clientId;
        const txId = monitor.startToolCall({
          tool: tool.name,
          args,
          sessionId: extra.sessionId,
          requestId: extra.requestId,
          clientId: resolvedClientId,
          remoteIp: context.remoteIp,
          startedAtMs,
        });
        const auditBase = {
          tool: tool.name,
          args,
          sessionId: extra.sessionId,
          requestId: extra.requestId,
          clientId: resolvedClientId,
          remoteIp: context.remoteIp,
          startedAtMs,
        };
        try {
          const result = await tool.handler(args);
          monitor.finishToolCall(txId, { result });
          await auditToolCall({ ...auditBase, result });
          return result;
        } catch (err) {
          monitor.finishToolCall(txId, { error: err });
          await auditToolCall({ ...auditBase, error: err });
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `ERRO: ${message}` }], isError: true };
        }
      },
    );
  }

  return server;
}

const app = express();

// Por padrao, confia apenas em proxies locais (ex.: cloudflared em 127.0.0.1).
// Isso permite que req.ip reflita X-Forwarded-For sem aceitar spoofing de clientes remotos diretos.
const trustProxyRaw = (process.env.MCP_TRUST_PROXY ?? "loopback").trim();
if (trustProxyRaw.toLowerCase() === "false") app.set("trust proxy", false);
else if (trustProxyRaw.toLowerCase() === "true") app.set("trust proxy", true);
else if (/^\d+$/.test(trustProxyRaw)) app.set("trust proxy", Number(trustProxyRaw));
else app.set("trust proxy", trustProxyRaw);

// Parser JSON enxuto para rotas publicas/OAuth; o parser de 50 MB do /mcp roda somente apos checkAuth.
const smallJsonParser = express.json({ limit: "256kb" });
const mcpJsonParser = express.json({ limit: "50mb" });
app.use((req, res, next) => {
  if (req.path === "/mcp") return next();
  return smallJsonParser(req, res, next);
});

// Endpoints OAuth (para o ChatGPT e outros clientes MCP que exigem OAuth):
// /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource/mcp,
// /authorize, /token, /register (DCR) e /revoke — mais a tela de aprovacao.
app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(PUBLIC_URL),
    resourceServerUrl: mcpUrl,
    resourceName: "mcp-dev-agent",
  }),
);
app.use(oauthProvider.approvalRouter());
app.use(monitor.router());

/**
 * Normaliza o header Authorization e extrai o token.
 * Tolera: token cru, "Bearer <t>", esquema em qualquer caixa e prefixo "Bearer"
 * duplicado (comum quando o conector do Copilot Studio ja adiciona o esquema).
 */
function extractToken(header: string): string {
  let value = header.trim();
  // Remove prefixos "bearer " repetidos (case-insensitive), ex: "Bearer Bearer <t>".
  while (/^bearer\s+/i.test(value)) {
    value = value.replace(/^bearer\s+/i, "");
  }
  return value.trim();
}

/** Mascara o token para logs: mostra so os 4 primeiros e ultimos caracteres. */
function mask(t: string): string {
  if (t.length <= 8) return "****";
  return `${t.slice(0, 4)}...${t.slice(-4)} (len ${t.length})`;
}

/**
 * Autenticacao em todas as rotas MCP. Aceita duas credenciais:
 * - o token estatico MCP_AUTH_TOKEN (Copilot Studio);
 * - um access token OAuth emitido por este servidor (ChatGPT).
 */
interface AuthContext {
  type: "static" | "oauth";
  clientId: string;
}

async function checkAuth(req: Request, res: Response): Promise<AuthContext | null> {
  const rawHeader = (req.headers.authorization as string | undefined) ?? "";
  const token = extractToken(rawHeader);

  if (token === AUTH_TOKEN) return { type: "static", clientId: "static-token" };
  if (token) {
    try {
      const info = await oauthProvider.verifyAccessToken(token);
      return { type: "oauth", clientId: info.clientId };
    } catch {
      // Nao e um access token OAuth valido; cai no 401 abaixo.
    }
  }

  console.warn(
    `[auth] 401 ${req.method} ${req.path} | header ${rawHeader ? "presente" : "AUSENTE"} | ` +
      `token recebido: ${rawHeader ? mask(token) : "(nenhum)"}`,
  );
  monitor.recordEvent({
    category: "auth",
    event: "auth.failed",
    status: "error",
    remoteIp: req.ip,
    error: `401 ${req.method} ${req.path} (${rawHeader ? `token ${mask(token)}` : "sem header Authorization"})`,
  });
  // WWW-Authenticate aponta o resource metadata para clientes OAuth (spec MCP).
  res.setHeader(
    "WWW-Authenticate",
    `Bearer error="invalid_token", error_description="Token invalido ou ausente", ` +
      `resource_metadata="${getOAuthProtectedResourceMetadataUrl(mcpUrl)}"`,
  );
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Nao autorizado: Bearer token invalido ou ausente." },
    id: null,
  });
  return null;
}

// Sessoes ativas, indexadas pelo header Mcp-Session-Id.
const transports = new Map<string, StreamableHTTPServerTransport>();

function closeIdleSession(sessionId: string, reason: "closed" | "expired"): void {
  const transport = transports.get(sessionId);
  transports.delete(sessionId);
  monitor.closeSession(sessionId, reason);
  if (transport) void transport.close().catch(() => undefined);
}

function evictOverflowIdleSessions(): void {
  if (!Number.isFinite(MAX_IDLE_SESSIONS) || MAX_IDLE_SESSIONS <= 0) return;
  if (transports.size <= MAX_IDLE_SESSIONS) return;
  const idleCandidates = monitor
    .getActiveSessions()
    .filter((s) => s.inFlightCount === 0 && !s.sseConnected)
    .sort((a, b) => a.lastActivityMs - b.lastActivityMs);
  while (transports.size > MAX_IDLE_SESSIONS && idleCandidates.length > 0) {
    const oldest = idleCandidates.shift()!;
    closeIdleSession(oldest.sessionId, "expired");
  }
}

// Limpeza periodica de sessoes ociosas para evitar vazamento de memoria quando clientes desconectam sem DELETE /mcp.
if (Number.isFinite(SESSION_IDLE_TTL_MS) && SESSION_IDLE_TTL_MS > 0) {
  const sweepIntervalMs = Math.min(60_000, Math.max(5_000, Math.floor(SESSION_IDLE_TTL_MS / 2)));
  setInterval(() => {
    const now = Date.now();
    for (const session of monitor.getActiveSessions()) {
      if (
        session.inFlightCount === 0 &&
        !session.sseConnected &&
        now - session.lastActivityMs > SESSION_IDLE_TTL_MS
      ) {
        closeIdleSession(session.sessionId, "expired");
      }
    }
  }, sweepIntervalMs).unref();
}

app.post(
  "/mcp",
  async (req: Request, res: Response, next) => {
    const auth = await checkAuth(req, res);
    if (!auth) return;
    (req as Request & { mcpAuth?: AuthContext }).mcpAuth = auth;
    mcpJsonParser(req, res, next);
  },
  async (req: Request, res: Response) => {
    const auth = (req as Request & { mcpAuth: AuthContext }).mcpAuth;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      const clientInfo = req.body?.params?.clientInfo as { name?: string; version?: string } | undefined;
      const protocolVersion = req.body?.params?.protocolVersion as string | undefined;
      // Nova sessao.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
          monitor.registerSession({
            sessionId: id,
            clientId: auth.clientId,
            clientName: clientInfo?.name,
            clientVersion: clientInfo?.version,
            authType: auth.type,
            remoteIp: req.ip,
            userAgent: req.headers["user-agent"],
          });
          if (LOG_PROTOCOL_EVENTS) {
            monitor.recordEvent({
              category: "mcp",
              event: "mcp.initialize",
              sessionId: id,
              requestId: req.body?.id ?? null,
              clientId: auth.clientId,
              remoteIp: req.ip,
              summary: `Sessao iniciada (${clientInfo?.name ?? auth.clientId}${clientInfo?.version ? ` v${clientInfo.version}` : ""})`,
              args: { protocolVersion, clientInfo },
            });
          }
          evictOverflowIdleSessions();
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) {
          const closedId = transport!.sessionId;
          transports.delete(closedId);
          monitor.closeSession(closedId, "closed");
        }
      };
      await buildServer({ remoteIp: req.ip, clientId: auth.clientId }).connect(transport);
    } else if (!transport) {
      monitor.recordEvent({
        category: "mcp",
        event: "mcp.invalid_session",
        status: "error",
        sessionId: sessionId ?? null,
        clientId: auth.clientId,
        remoteIp: req.ip,
        error: "Sessao invalida ou ausente em chamada POST /mcp",
      });
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Sessao invalida: envie um request de initialize primeiro." },
        id: null,
      });
      return;
    } else {
      monitor.touchSession(sessionId, { remoteIp: req.ip, clientId: auth.clientId });
      const rpcMethod = typeof req.body?.method === "string" ? req.body.method : undefined;
      if (
        LOG_PROTOCOL_EVENTS &&
        rpcMethod &&
        rpcMethod !== "tools/call" &&
        rpcMethod !== "ping" &&
        !rpcMethod.startsWith("notifications/")
      ) {
        monitor.recordEvent({
          category: "mcp",
          event: `mcp.${rpcMethod.replace(/\//g, "_")}`,
          sessionId,
          requestId: req.body?.id ?? null,
          clientId: auth.clientId,
          remoteIp: req.ip,
          summary: `Metodo MCP: ${rpcMethod}`,
        });
      }
    }

    await transport.handleRequest(req, res, req.body);
  },
);

// GET/DELETE para o canal de eventos SSE e encerramento de sessao.
async function handleSession(req: Request, res: Response) {
  const auth = await checkAuth(req, res);
  if (!auth) return;
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Sessao invalida ou ausente.");
    return;
  }
  if (req.method === "GET" && sessionId) {
    monitor.touchSession(sessionId, { sseConnected: true, remoteIp: req.ip });
    if (LOG_PROTOCOL_EVENTS) {
      monitor.recordEvent({
        category: "mcp",
        event: "mcp.sse_open",
        sessionId,
        clientId: auth.clientId,
        remoteIp: req.ip,
        summary: "Canal SSE da sessao MCP conectado",
      });
    }
    req.on("close", () => {
      monitor.touchSession(sessionId, { sseConnected: false });
    });
  } else if (req.method === "DELETE" && sessionId) {
    monitor.recordEvent({
      category: "mcp",
      event: "mcp.session_delete",
      sessionId,
      clientId: auth.clientId,
      remoteIp: req.ip,
      summary: "Sessao encerrada pelo cliente (DELETE /mcp)",
    });
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", handleSession);
app.delete("/mcp", handleSession);

// Health check simples (sem auth) para probes de infraestrutura.
app.get("/health", (_req, res) => res.json({ status: "ok", tools: tools.map((t) => t.name) }));

app.listen(PORT, HOST, () => {
  console.log(`MCP dev-agent ouvindo em http://${HOST}:${PORT}/mcp`);
  console.log(`Painel de acompanhamento em tempo real: http://${HOST}:${PORT}/logs`);
  console.log(`OAuth: issuer ${PUBLIC_URL} | auth via token estatico OU access token OAuth`);
  console.log(`Ferramentas: ${tools.map((t) => t.name).join(", ")}`);
});
