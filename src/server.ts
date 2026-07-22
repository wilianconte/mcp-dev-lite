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

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
// URL publica (issuer OAuth e resource do MCP). Em producao: https://mcp.criaelo.com
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;

if (!AUTH_TOKEN) {
  console.error(
    "ERRO: defina a variavel de ambiente MCP_AUTH_TOKEN com um token secreto antes de iniciar.\n" +
      "Ex: MCP_AUTH_TOKEN=$(openssl rand -hex 32) npm start",
  );
  process.exit(1);
}

// Senha exigida na tela de aprovacao OAuth (fallback: o proprio MCP_AUTH_TOKEN).
const APPROVAL_PASSWORD = process.env.OAUTH_APPROVAL_PASSWORD ?? AUTH_TOKEN;
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const oauthProvider = new DevAgentOAuthProvider(DATA_DIR, APPROVAL_PASSWORD);
const mcpUrl = new URL("/mcp", PUBLIC_URL);

/** Cria uma instancia do servidor MCP com todas as ferramentas registradas. */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: "mcp-dev-agent", version: "1.0.0" },
    {
      instructions:
        "Servidor de desenvolvimento: executa comandos e manipula arquivos na VM. " +
        "O agente decide quais comandos rodar para desenvolver e alterar as aplicacoes.",
    },
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.schema },
      async (args: Record<string, unknown>) => {
        try {
          const text = await tool.handler(args);
          return { content: [{ type: "text", text }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `ERRO: ${message}` }], isError: true };
        }
      },
    );
  }

  return server;
}

const app = express();
app.use(express.json({ limit: "50mb" }));

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

/**
 * Autenticacao em todas as rotas MCP. Aceita duas credenciais:
 * - o token estatico MCP_AUTH_TOKEN (Copilot Studio);
 * - um access token OAuth emitido por este servidor (ChatGPT).
 */
async function checkAuth(req: Request, res: Response): Promise<boolean> {
  const rawHeader = (req.headers.authorization as string | undefined) ?? "";
  const token = extractToken(rawHeader);

  if (token === AUTH_TOKEN) return true;
  if (token) {
    try {
      await oauthProvider.verifyAccessToken(token);
      return true;
    } catch {
      // Nao e um access token OAuth valido; cai no 401 abaixo.
    }
  }

  console.warn(
    `[auth] 401 ${req.method} ${req.path} | header ${rawHeader ? "presente" : "AUSENTE"} | ` +
      `token recebido: ${rawHeader ? mask(token) : "(nenhum)"}`,
  );
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
  return false;
}

// Sessoes ativas, indexadas pelo header Mcp-Session-Id.
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req: Request, res: Response) => {
  if (!(await checkAuth(req, res))) return;

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport && isInitializeRequest(req.body)) {
    // Nova sessao.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };
    await buildServer().connect(transport);
  } else if (!transport) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Sessao invalida: envie um request de initialize primeiro." },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// GET/DELETE para o canal de eventos SSE e encerramento de sessao.
async function handleSession(req: Request, res: Response) {
  if (!(await checkAuth(req, res))) return;
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Sessao invalida ou ausente.");
    return;
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", handleSession);
app.delete("/mcp", handleSession);

// Health check simples (sem auth) para probes de infraestrutura.
app.get("/health", (_req, res) => res.json({ status: "ok", tools: tools.map((t) => t.name) }));

app.listen(PORT, HOST, () => {
  console.log(`MCP dev-agent ouvindo em http://${HOST}:${PORT}/mcp`);
  console.log(`OAuth: issuer ${PUBLIC_URL} | auth via token estatico OU access token OAuth`);
  console.log(`Ferramentas: ${tools.map((t) => t.name).join(", ")}`);
});
