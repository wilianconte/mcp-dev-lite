#!/usr/bin/env node
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools.js";
import { DevAgentOAuthProvider } from "./oauth.js";
import { MCP_SERVER_VERSION, auditLogPath, auditToolCall } from "./audit.js";
import { McpMonitor, renderMonitorLoginHtml } from "./monitor.js";

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
  : path.resolve(process.cwd(), "data");

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
    { name: "mcp-dev-agent", version: MCP_SERVER_VERSION },
    {
      instructions:
        "Servidor de desenvolvimento na VM (17 ferramentas). Siga estas diretrizes de escolha de ferramentas para maxima performance:\n" +
        "1. LOCALIZACAO E EXISTENCIA DE CAMINHOS: Para checar se 1 ou mais arquivos/diretorios existem (sem erro ENOENT), use stat_path (ou read_file com allow_missing=true). Use find_files para localizar arquivos ou worktrees por nome, substring ou glob, aceitando alternancia com '|' (ex.: pattern='sidebar', pattern='*inbox*|*media*|*.spec.ts', max_depth=1..10; tambem lista diretorios de topo correspondentes e busca automaticamente em .sdd/.superpowers) e list_directory (com pattern opcional para filtrar por nome/glob e max_depth de 1 a 4) para explorar a estrutura de pastas. Nunca use find/ls/test via run_command.\n" +
        "2. BUSCA EM CODIGO: Use SEMPRE search_code (ripgrep nativo) para buscar texto/regex dentro de arquivos. Passe o path mais especifico possivel (ex.: '/root/repos/app/src') e use fixed_strings=true ao buscar trechos literais com (), {}, [] ou $.\n" +
        "3. LEITURA DE ARQUIVOS: Para 1 arquivo use read_file (use allow_missing=true se o arquivo puder nao existir); para 2 a 20 arquivos (ou 2 ou mais faixas offset/limit distantes do mesmo arquivo grande) use read_files em lote (leitura paralela). Evite cat/head/tail/sed via run_command. Arquivos binarios sao bloqueados automaticamente.\n" +
        "4. EDICAO DE ARQUIVOS: Para alterar 1 trecho use edit_file; para alterar 2 ou mais trechos no mesmo arquivo use multi_edit_file (atomico); para criar/sobrescrever o arquivo inteiro use write_file.\n" +
        "5. COMANDOS CURTOS VS LONGOS: Use run_command apenas para operacoes rapidas (<30s, como git status, git diff, gh pr view). Para builds, suites de teste, deploys, instalacoes, gh run watch (use 'gh run watch <id> --interval 15'), pipelines encadeados (lint && build && test) ou invocacao de subagentes CLI (agy), use SEMPRE start_command seguido de poll_command passando offset=next_offset da chamada anterior e wait_ms=60000..180000 (use 120000..180000 para agy, vitest, playwright, gh run watch e builds longos) para aguardar apenas novas linhas (stdout/stderr) sem polling excessivo.\n" +
        "6. SAIDAS GRANDES E IMAGENS: Saidas >30k chars geram artifact_id (retido por 24h) para leitura paginada via read_command_output. Para screenshots/imagens (PNG/JPEG/GIF/WebP), use read_image (ImageContent MCP nativo).",
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
          const details = err instanceof Error ? err.stack ?? err.message : String(err);
          return { content: [{ type: "text" as const, text: `ERRO: ${details}` }], isError: true };
        }
      },
    );
  }

  return server;
}

const app = express();
app.disable("x-powered-by");

// Por padrao, confia apenas em proxies locais (ex.: cloudflared em 127.0.0.1).
// Isso permite que req.ip reflita X-Forwarded-For sem aceitar spoofing de clientes remotos diretos.
const trustProxyRaw = (process.env.MCP_TRUST_PROXY ?? "loopback").trim();
if (trustProxyRaw.toLowerCase() === "false") app.set("trust proxy", false);
else if (trustProxyRaw.toLowerCase() === "true") app.set("trust proxy", true);
else if (/^\d+$/.test(trustProxyRaw)) app.set("trust proxy", Number(trustProxyRaw));
else app.set("trust proxy", trustProxyRaw);

// Parser JSON enxuto para rotas publicas/OAuth; o parser do /mcp roda somente apos checkAuth.
const smallJsonParser = express.json({ limit: "256kb" });
const MCP_REQUEST_BODY_LIMIT = process.env.MCP_REQUEST_BODY_LIMIT?.trim() || "16mb";
const mcpJsonParser = express.json({ limit: MCP_REQUEST_BODY_LIMIT });
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

function matchesStaticToken(candidate: string): boolean {
  if (!AUTH_TOKEN) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(AUTH_TOKEN);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
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

  if (matchesStaticToken(token)) return { type: "static", clientId: "static-token" };
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

interface MonitorCookieSession {
  auth: AuthContext;
  expiresAt: number;
}

const monitorCookieSessions = new Map<string, MonitorCookieSession>();
const MONITOR_COOKIE_TTL_MS = 15 * 60 * 1000;
const MONITOR_COOKIE_NAME = "mcp_monitor_session";
const MONITOR_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const parsedMonitorLoginMaxAttempts = Number(process.env.MCP_MONITOR_LOGIN_MAX_ATTEMPTS ?? 10);
const MONITOR_LOGIN_MAX_ATTEMPTS = Number.isInteger(parsedMonitorLoginMaxAttempts) && parsedMonitorLoginMaxAttempts > 0
  ? parsedMonitorLoginMaxAttempts
  : 10;
const monitorLoginAttempts = new Map<string, { count: number; resetAt: number }>();

function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function issueMonitorCookie(req: Request, res: Response, auth: AuthContext): void {
  const sessionId = randomUUID();
  monitorCookieSessions.set(sessionId, { auth, expiresAt: Date.now() + MONITOR_COOKIE_TTL_MS });
  while (monitorCookieSessions.size > 100) {
    const oldest = monitorCookieSessions.keys().next().value;
    if (oldest === undefined) break;
    monitorCookieSessions.delete(oldest);
  }
  const secure = req.protocol === "https" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${MONITOR_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/logs; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(MONITOR_COOKIE_TTL_MS / 1000)}${secure}`,
  );
}

function clearMonitorCookie(req: Request, res: Response): void {
  const secure = req.protocol === "https" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${MONITOR_COOKIE_NAME}=; Path=/logs; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
  );
}

async function checkMonitorAuth(req: Request, res: Response): Promise<AuthContext | null> {
  const rawHeader = (req.headers.authorization as string | undefined) ?? "";
  if (rawHeader.trim()) {
    const auth = await checkAuth(req, res);
    if (auth) issueMonitorCookie(req, res, auth);
    return auth;
  }

  const cookieId = parseCookieHeader(req.headers.cookie, MONITOR_COOKIE_NAME);
  const cookieSession = cookieId ? monitorCookieSessions.get(cookieId) : undefined;
  if (cookieSession && cookieSession.expiresAt > Date.now()) {
    cookieSession.expiresAt = Date.now() + MONITOR_COOKIE_TTL_MS;
    return cookieSession.auth;
  }
  if (cookieId) monitorCookieSessions.delete(cookieId);

  return checkAuth(req, res);
}

async function requireMonitorAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const acceptsHtml = req.headers.accept?.includes("text/html") && !req.headers.accept?.includes("application/json");
  const hasAuthorization = Boolean((req.headers.authorization as string | undefined)?.trim());
  if (acceptsHtml && !hasAuthorization) {
    const cookieId = parseCookieHeader(req.headers.cookie, MONITOR_COOKIE_NAME);
    const cookieSession = cookieId ? monitorCookieSessions.get(cookieId) : undefined;
    if (!cookieSession || cookieSession.expiresAt <= Date.now()) {
      if (cookieId) {
        monitorCookieSessions.delete(cookieId);
        clearMonitorCookie(req, res);
      }
      res.redirect(302, "/logs/login");
      return;
    }
  }
  if (await checkMonitorAuth(req, res)) next();
}

const monitorFormParser = express.urlencoded({ extended: false, limit: "8kb" });
app.get("/logs/login", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).type("html").send(renderMonitorLoginHtml());
});

app.post("/logs/login", monitorFormParser, (req: Request, res: Response) => {
  const ip = req.ip ?? "?";
  const now = Date.now();
  if (monitorLoginAttempts.size > 1_000) {
    for (const [knownIp, knownAttempts] of monitorLoginAttempts) {
      if (knownAttempts.resetAt <= now) monitorLoginAttempts.delete(knownIp);
    }
  }
  const attempts = monitorLoginAttempts.get(ip);
  if (attempts && attempts.resetAt <= now) monitorLoginAttempts.delete(ip);
  const currentAttempts = monitorLoginAttempts.get(ip);
  if (currentAttempts && currentAttempts.count >= MONITOR_LOGIN_MAX_ATTEMPTS) {
    res.setHeader("Retry-After", String(Math.ceil((currentAttempts.resetAt - now) / 1000)));
    res.status(429).type("html").send(renderMonitorLoginHtml("Muitas tentativas. Aguarde alguns minutos."));
    return;
  }
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!matchesStaticToken(token)) {
    const nextAttempts = currentAttempts && currentAttempts.resetAt > now
      ? currentAttempts
      : { count: 0, resetAt: now + MONITOR_LOGIN_WINDOW_MS };
    nextAttempts.count += 1;
    monitorLoginAttempts.set(ip, nextAttempts);
    res.setHeader("Cache-Control", "no-store");
    res.status(401).type("html").send(renderMonitorLoginHtml("Token inválido. Tente novamente."));
    return;
  }
  monitorLoginAttempts.delete(ip);
  issueMonitorCookie(req, res, { type: "static", clientId: "static-token" });
  res.redirect(303, "/logs");
});

app.post("/logs/logout", (req: Request, res: Response) => {
  const cookieId = parseCookieHeader(req.headers.cookie, MONITOR_COOKIE_NAME);
  if (cookieId) monitorCookieSessions.delete(cookieId);
  clearMonitorCookie(req, res);
  res.redirect(303, "/logs/login");
});

const monitorRouter = express.Router();
monitorRouter.use("/logs", requireMonitorAuth);
monitorRouter.use(monitor.router());
app.use(monitorRouter);

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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
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
    } catch (err) {
      next(err);
    }
  },
);

// GET/DELETE para o canal de eventos SSE e encerramento de sessao.
async function handleSessionRequest(req: Request, res: Response): Promise<void> {
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

async function handleSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await handleSessionRequest(req, res);
  } catch (err) {
    next(err);
  }
}

app.get("/mcp", handleSession);
app.delete("/mcp", handleSession);

// Health check simples (sem auth) para probes de infraestrutura.
app.get("/health", (_req, res) =>
  res.json({ status: "ok", version: MCP_SERVER_VERSION }),
);

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const error = err instanceof Error ? err : new Error(String(err));
  const status = Number((err as { status?: unknown; statusCode?: unknown })?.statusCode ?? (err as { status?: unknown })?.status);
  const responseStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
  const authenticatedMcp = Boolean((req as Request & { mcpAuth?: AuthContext }).mcpAuth);
  if (authenticatedMcp && req.path === "/mcp") {
    res.status(responseStatus).json({
      jsonrpc: "2.0",
      error: { code: responseStatus === 400 ? -32700 : -32603, message: error.stack ?? error.message },
      id: null,
    });
    return;
  }
  res.status(responseStatus).json({ error: "Erro interno do servidor." });
});

app.listen(PORT, HOST, () => {
  console.log(`MCP dev-agent ouvindo em http://${HOST}:${PORT}/mcp`);
  console.log(`Painel de acompanhamento em tempo real: http://${HOST}:${PORT}/logs`);
  console.log(`OAuth: issuer ${PUBLIC_URL} | auth via token estatico OU access token OAuth`);
  console.log(`Ferramentas: ${tools.map((t) => t.name).join(", ")}`);
});
