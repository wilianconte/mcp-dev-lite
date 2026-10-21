import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { Router, type Request, type Response } from "express";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  sanitizeAuditValue,
  summarizeToolResult,
  truncateString,
  type ToolResultSummary,
} from "./audit.js";

const DEFAULT_MAX_TRANSACTIONS = 500;
const MAX_RECENT_CLOSED_SESSIONS = 50;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_HYDRATE_AUDIT_BYTES = 2 * 1024 * 1024;

export type TransactionCategory = "tool_call" | "mcp" | "oauth" | "auth";
export type TransactionStatus = "running" | "ok" | "error";

export interface SessionSnapshot {
  sessionId: string;
  clientId: string;
  clientName?: string;
  clientVersion?: string;
  authType: "static" | "oauth";
  remoteIp: string;
  userAgent?: string;
  connectedAt: string;
  lastActivityAt: string;
  lastActivityMs: number;
  disconnectedAt?: string;
  status: "active" | "closed" | "expired";
  sseConnected: boolean;
  inFlightCount: number;
  totalCalls: number;
  errorCount: number;
}

export interface TransactionRecord {
  id: string;
  timestamp: string;
  startedAtMs: number;
  finishedAtMs?: number;
  durationMs?: number;
  category: TransactionCategory;
  event: string;
  status: TransactionStatus;
  tool?: string;
  sessionId?: string | null;
  requestId?: string | number | null;
  clientId?: string | null;
  remoteIp?: string | null;
  summary?: string;
  args?: unknown;
  result?: ToolResultSummary;
  error?: string;
}

export interface MonitorStats {
  activeSessions: number;
  sseStreams: number;
  inFlightCalls: number;
  totalTransactions: number;
  totalToolCalls: number;
  totalErrors: number;
  avgDurationMs: number;
}

export interface MonitorSnapshot {
  server: {
    name: string;
    version: string;
    startedAt: string;
    uptimeSec: number;
  };
  stats: MonitorStats;
  sessions: SessionSnapshot[];
  transactions: TransactionRecord[];
}

export class McpMonitor {
  private readonly startedAtMs = Date.now();
  private readonly maxTransactions: number;
  private readonly activeSessions = new Map<string, SessionSnapshot>();
  private readonly closedSessions: SessionSnapshot[] = [];
  private readonly transactions: TransactionRecord[] = [];
  private readonly transactionsById = new Map<string, TransactionRecord>();
  private readonly sseClients = new Set<Response>();
  private totalTransactionsSeen = 0;
  private totalToolCallsSeen = 0;
  private totalErrorsSeen = 0;
  private totalDurationMs = 0;
  private completedToolCallsCount = 0;

  constructor(maxTransactions?: number) {
    const envLimit = Number(process.env.MCP_LOG_BUFFER_SIZE ?? DEFAULT_MAX_TRANSACTIONS);
    this.maxTransactions =
      maxTransactions ?? (Number.isFinite(envLimit) && envLimit >= 50 ? Math.min(envLimit, 5_000) : DEFAULT_MAX_TRANSACTIONS);
  }

  /** Carrega ultimos registros do arquivo JSONL de auditoria (lendo apenas a cauda de ate 2 MiB) para popular o historico inicial. */
  async hydrateFromAuditFile(filePath: string | null): Promise<void> {
    if (!filePath) return;
    try {
      const handle = await open(filePath, "r");
      let content = "";
      try {
        const st = await handle.stat();
        if (st.size <= 0) return;
        const readLen = Math.min(st.size, MAX_HYDRATE_AUDIT_BYTES);
        const startOffset = st.size - readLen;
        const buf = Buffer.allocUnsafe(readLen);
        const { bytesRead } = await handle.read(buf, 0, readLen, startOffset);
        content = buf.subarray(0, bytesRead).toString("utf8");
        if (startOffset > 0) {
          const firstNewline = content.indexOf("\n");
          content = firstNewline !== -1 ? content.slice(firstNewline + 1) : "";
        }
      } finally {
        await handle.close();
      }
      const lines = content.trim().split("\n").filter(Boolean);
      const recent = lines.slice(-this.maxTransactions);
      for (const line of recent) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString();
          const durationMs = typeof parsed.duration_ms === "number" ? parsed.duration_ms : 0;
          const finishedMs = Date.parse(ts) || Date.now();
          const resultObj = parsed.result as ToolResultSummary | undefined;
          const isErr = Boolean(parsed.error) || Boolean(resultObj?.is_error);
          const record: TransactionRecord = {
            id: randomUUID(),
            timestamp: ts,
            startedAtMs: Math.max(0, finishedMs - durationMs),
            finishedAtMs: finishedMs,
            durationMs,
            category: "tool_call",
            event: typeof parsed.event === "string" ? parsed.event : "mcp.tool_call",
            status: isErr ? "error" : "ok",
            tool: typeof parsed.tool === "string" ? parsed.tool : undefined,
            sessionId: (parsed.session_id as string | null) ?? null,
            requestId: (parsed.request_id as string | number | null) ?? null,
            clientId: (parsed.client_id as string | null) ?? null,
            remoteIp: (parsed.remote_ip as string | null) ?? null,
            args: parsed.args,
            result: resultObj,
            error: typeof parsed.error === "string" ? parsed.error : undefined,
          };
          this.pushTransaction(record, false);
          this.totalToolCallsSeen += 1;
          this.completedToolCallsCount += 1;
          this.totalDurationMs += durationMs;
          if (isErr) this.totalErrorsSeen += 1;
        } catch {
          // Ignora linhas malformadas no historico.
        }
      }
    } catch {
      // Arquivo ainda nao existe; ignora.
    }
  }

  private pushTransaction(record: TransactionRecord, broadcast = true): void {
    this.transactions.push(record);
    this.transactionsById.set(record.id, record);
    this.totalTransactionsSeen += 1;
    while (this.transactions.length > this.maxTransactions) {
      const removed = this.transactions.shift();
      if (removed) this.transactionsById.delete(removed.id);
    }
    if (broadcast) {
      this.broadcast("transaction", { action: "create", transaction: record, stats: this.getStats() });
    }
  }

  registerSession(params: {
    sessionId: string;
    clientId: string;
    clientName?: string;
    clientVersion?: string;
    authType: "static" | "oauth";
    remoteIp?: string;
    userAgent?: string;
  }): SessionSnapshot {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const snapshot: SessionSnapshot = {
      sessionId: params.sessionId,
      clientId: params.clientId,
      clientName: params.clientName,
      clientVersion: params.clientVersion,
      authType: params.authType,
      remoteIp: params.remoteIp ?? "desconhecido",
      userAgent: params.userAgent,
      connectedAt: nowIso,
      lastActivityAt: nowIso,
      lastActivityMs: now,
      status: "active",
      sseConnected: false,
      inFlightCount: 0,
      totalCalls: 0,
      errorCount: 0,
    };
    this.activeSessions.set(params.sessionId, snapshot);
    this.broadcast("session", { action: "open", session: snapshot, stats: this.getStats() });
    return snapshot;
  }

  touchSession(
    sessionId: string | undefined,
    updates?: { sseConnected?: boolean; remoteIp?: string; clientId?: string },
  ): SessionSnapshot | undefined {
    if (!sessionId) return undefined;
    const session = this.activeSessions.get(sessionId);
    if (!session) return undefined;
    const now = Date.now();
    session.lastActivityMs = now;
    session.lastActivityAt = new Date(now).toISOString();
    if (updates?.sseConnected !== undefined) session.sseConnected = updates.sseConnected;
    if (updates?.remoteIp) session.remoteIp = updates.remoteIp;
    if (updates?.clientId) session.clientId = updates.clientId;
    this.broadcast("session", { action: "update", session, stats: this.getStats() });
    return session;
  }

  closeSession(sessionId: string | undefined, reason: "closed" | "expired" = "closed"): void {
    if (!sessionId) return;
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    this.activeSessions.delete(sessionId);
    const nowIso = new Date().toISOString();
    session.status = reason;
    session.sseConnected = false;
    session.inFlightCount = 0;
    session.disconnectedAt = nowIso;
    session.lastActivityAt = nowIso;
    this.closedSessions.unshift(session);
    while (this.closedSessions.length > MAX_RECENT_CLOSED_SESSIONS) {
      this.closedSessions.pop();
    }
    this.broadcast("session", { action: "close", session, stats: this.getStats() });
  }

  getActiveSessions(): SessionSnapshot[] {
    return Array.from(this.activeSessions.values());
  }

  startToolCall(params: {
    tool: string;
    args: Record<string, unknown>;
    sessionId?: string;
    requestId?: string | number;
    clientId?: string;
    remoteIp?: string;
    startedAtMs?: number;
  }): string {
    const startedAtMs = params.startedAtMs ?? Date.now();
    const id = randomUUID();
    const session = params.sessionId ? this.activeSessions.get(params.sessionId) : undefined;
    if (session) {
      session.inFlightCount += 1;
      session.totalCalls += 1;
      session.lastActivityMs = startedAtMs;
      session.lastActivityAt = new Date(startedAtMs).toISOString();
    }
    this.totalToolCallsSeen += 1;
    const record: TransactionRecord = {
      id,
      timestamp: new Date(startedAtMs).toISOString(),
      startedAtMs,
      category: "tool_call",
      event: "mcp.tool_call",
      status: "running",
      tool: params.tool,
      sessionId: params.sessionId ?? null,
      requestId: params.requestId ?? null,
      clientId: params.clientId ?? session?.clientId ?? null,
      remoteIp: params.remoteIp ?? session?.remoteIp ?? null,
      args: sanitizeAuditValue(params.args),
    };
    this.pushTransaction(record, true);
    if (session) {
      this.broadcast("session", { action: "update", session, stats: this.getStats() });
    }
    return id;
  }

  finishToolCall(
    id: string,
    outcome: { result?: CallToolResult; error?: unknown; finishedAtMs?: number },
  ): TransactionRecord | undefined {
    const record = this.transactionsById.get(id);
    const finishedAtMs = outcome.finishedAtMs ?? Date.now();
    if (!record) return undefined;

    record.finishedAtMs = finishedAtMs;
    record.durationMs = Math.max(0, finishedAtMs - record.startedAtMs);
    record.timestamp = new Date(finishedAtMs).toISOString();

    if (outcome.result) {
      record.result = summarizeToolResult(outcome.result, true);
    }
    if (outcome.error) {
      record.error = truncateString(
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      );
    }

    const isError = Boolean(outcome.error) || Boolean(record.result?.is_error);
    record.status = isError ? "error" : "ok";

    this.completedToolCallsCount += 1;
    this.totalDurationMs += record.durationMs;
    if (isError) this.totalErrorsSeen += 1;

    const session = record.sessionId ? this.activeSessions.get(record.sessionId) : undefined;
    if (session) {
      session.inFlightCount = Math.max(0, session.inFlightCount - 1);
      if (isError) session.errorCount += 1;
      session.lastActivityMs = finishedAtMs;
      session.lastActivityAt = new Date(finishedAtMs).toISOString();
      this.broadcast("session", { action: "update", session, stats: this.getStats() });
    }

    this.broadcast("transaction", { action: "update", transaction: record, stats: this.getStats() });
    return record;
  }

  recordEvent(params: {
    category: TransactionCategory;
    event: string;
    status?: TransactionStatus;
    sessionId?: string | null;
    requestId?: string | number | null;
    clientId?: string | null;
    remoteIp?: string | null;
    summary?: string;
    args?: Record<string, unknown>;
    error?: string;
    durationMs?: number;
  }): TransactionRecord {
    const now = Date.now();
    const status = params.status ?? (params.error ? "error" : "ok");
    if (status === "error") this.totalErrorsSeen += 1;
    const record: TransactionRecord = {
      id: randomUUID(),
      timestamp: new Date(now).toISOString(),
      startedAtMs: now - (params.durationMs ?? 0),
      finishedAtMs: now,
      durationMs: params.durationMs ?? 0,
      category: params.category,
      event: params.event,
      status,
      sessionId: params.sessionId ?? null,
      requestId: params.requestId ?? null,
      clientId: params.clientId ?? null,
      remoteIp: params.remoteIp ?? null,
      summary: params.summary ? truncateString(params.summary, 500) : undefined,
      args: params.args ? sanitizeAuditValue(params.args) : undefined,
      error: params.error ? truncateString(params.error, 500) : undefined,
    };
    this.pushTransaction(record, true);
    return record;
  }

  getStats(): MonitorStats {
    let inFlightCalls = 0;
    let sseStreams = 0;
    for (const s of this.activeSessions.values()) {
      inFlightCalls += s.inFlightCount;
      if (s.sseConnected) sseStreams += 1;
    }
    return {
      activeSessions: this.activeSessions.size,
      sseStreams,
      inFlightCalls,
      totalTransactions: this.totalTransactionsSeen,
      totalToolCalls: this.totalToolCallsSeen,
      totalErrors: this.totalErrorsSeen,
      avgDurationMs:
        this.completedToolCallsCount > 0
          ? Math.round(this.totalDurationMs / this.completedToolCallsCount)
          : 0,
    };
  }

  getSnapshot(): MonitorSnapshot {
    const sessions = [
      ...Array.from(this.activeSessions.values()).sort((a, b) => b.lastActivityMs - a.lastActivityMs),
      ...this.closedSessions,
    ];
    return {
      server: {
        name: "mcp-dev-agent",
        version: "1.4.0",
        startedAt: new Date(this.startedAtMs).toISOString(),
        uptimeSec: Math.floor((Date.now() - this.startedAtMs) / 1000),
      },
      stats: this.getStats(),
      sessions,
      // Mais recentes primeiro na listagem inicial.
      transactions: [...this.transactions].reverse(),
    };
  }

  private broadcast(event: string, payload: unknown): void {
    if (this.sseClients.size === 0) return;
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(message);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  router(): Router {
    const router = Router();

    router.get(["/logs/api", "/logs/snapshot"], (_req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(this.getSnapshot());
    });

    router.get("/logs/stream", (req: Request, res: Response) => {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      res.write(`event: snapshot\ndata: ${JSON.stringify(this.getSnapshot())}\n\n`);
      this.sseClients.add(res);

      const heartbeat = setInterval(() => {
        try {
          res.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
          clearInterval(heartbeat);
          this.sseClients.delete(res);
        }
      }, SSE_HEARTBEAT_MS);
      heartbeat.unref();

      req.on("close", () => {
        clearInterval(heartbeat);
        this.sseClients.delete(res);
      });
    });

    router.get("/logs", (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      const wantsJson =
        req.query.format === "json" ||
        (req.headers.accept?.includes("application/json") && !req.headers.accept?.includes("text/html"));
      if (wantsJson) {
        res.json(this.getSnapshot());
        return;
      }
      res.status(200).type("html").send(renderLogsDashboardHtml());
    });

    return router;
  }
}

function renderLogsDashboardHtml(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>MCP Monitor — /logs</title>
<style>
  :root {
    --bg: #090d16;
    --panel: #111827;
    --panel-alt: #1e293b;
    --border: #1f2937;
    --text: #f3f4f6;
    --muted: #9ca3af;
    --accent: #38bdf8;
    --ok: #22c55e;
    --ok-bg: rgba(34, 197, 94, 0.12);
    --warn: #f59e0b;
    --warn-bg: rgba(245, 158, 11, 0.14);
    --err: #ef4444;
    --err-bg: rgba(239, 68, 68, 0.14);
    --run: #38bdf8;
    --run-bg: rgba(56, 189, 248, 0.15);
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    line-height: 1.45;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 20px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 20;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 700;
    font-size: 1rem;
  }
  .live-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 8px var(--ok);
    transition: background 0.2s;
  }
  .live-dot.disconnected {
    background: var(--err);
    box-shadow: 0 0 8px var(--err);
  }
  .live-dot.paused {
    background: var(--warn);
    box-shadow: 0 0 8px var(--warn);
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  button, select, input[type="search"] {
    background: var(--panel-alt);
    color: var(--text);
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
  }
  button {
    cursor: pointer;
    font-weight: 500;
  }
  button:hover { border-color: var(--accent); }
  button.active {
    background: rgba(56, 189, 248, 0.2);
    border-color: var(--accent);
    color: var(--accent);
  }
  main {
    max-width: 1600px;
    margin: 0 auto;
    padding: 16px 20px 40px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 12px;
  }
  .kpi {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
  }
  .kpi-label {
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .kpi-value {
    font-size: 22px;
    font-weight: 700;
    margin-top: 4px;
    font-family: var(--font-mono);
  }
  /* Barra de abas fora de containers: apenas linha divisoria inferior e indicador colorido na aba ativa */
  .tabs-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
    border-bottom: 1px solid var(--border);
    padding: 0 2px;
    margin-top: 4px;
  }
  .tabs-nav {
    display: flex;
    align-items: center;
    gap: 28px;
  }
  .tab-btn {
    position: relative;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    margin-bottom: -1px;
    padding: 10px 2px 12px;
    font-size: 14px;
    font-weight: 600;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
  }
  .tab-btn:hover {
    color: var(--text);
    border-bottom-color: #334155;
    background: transparent;
  }
  .tab-btn.active {
    color: var(--text);
    border-bottom-color: var(--accent);
    background: transparent;
  }
  .tab-btn.active .badge.neutral {
    color: var(--accent);
    background: rgba(56, 189, 248, 0.15);
  }
  /* Cada aba representa uma secao inteira (barra de filtros + card da grid separados) */
  .tab-panel {
    display: none;
    flex-direction: column;
    gap: 14px;
  }
  .tab-panel.active {
    display: flex;
  }
  .filter-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 16px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .filter-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    flex: 1;
  }
  .grid-section {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .section-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 12px 16px;
    background: rgba(15, 23, 42, 0.45);
    border-bottom: 1px solid var(--border);
  }
  .section-title {
    font-weight: 600;
    font-size: 13.5px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  th {
    color: var(--muted);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: rgba(15, 23, 42, 0.75);
  }
  tbody tr:last-child td {
    border-bottom: none;
  }
  tr.tx-row, tr.sess-row { cursor: pointer; transition: background 0.12s ease; }
  tr.tx-row:hover, tr.sess-row:hover { background: rgba(56, 189, 248, 0.04); }
  tr.tx-detail { background: #0b1120; display: none; }
  tr.tx-detail.open { display: table-row; }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--font-mono);
  }
  .badge.ok, .badge.active { color: var(--ok); background: var(--ok-bg); }
  .badge.error, .badge.expired { color: var(--err); background: var(--err-bg); }
  .badge.running { color: var(--run); background: var(--run-bg); }
  .badge.closed, .badge.neutral { color: var(--muted); background: rgba(156, 163, 175, 0.12); }
  .badge.warn { color: var(--warn); background: var(--warn-bg); }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .muted { color: var(--muted); }
  .truncate {
    max-width: 520px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: inline-block;
    vertical-align: bottom;
  }
  .detail-box {
    padding: 12px 16px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
  }
  pre {
    margin: 4px 0 0;
    padding: 10px;
    background: #060911;
    border: 1px solid #1e293b;
    border-radius: 6px;
    font-family: var(--font-mono);
    font-size: 12px;
    overflow-x: auto;
    max-height: 320px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .empty {
    padding: 32px;
    text-align: center;
    color: var(--muted);
  }
  .link-chip {
    color: var(--accent);
    text-decoration: underline dotted;
    cursor: pointer;
  }
</style>
</head>
<body>
<header>
  <div class="brand">
    <span id="live-dot" class="live-dot" title="Status do stream SSE"></span>
    <span>mcp-dev-agent</span>
    <span class="badge neutral">/logs</span>
    <span id="conn-status" class="muted" style="font-weight:400;font-size:12px;">Conectando ao stream...</span>
  </div>
  <div class="header-actions">
    <span id="uptime-label" class="muted mono">uptime: --</span>
    <button id="btn-pause" type="button">Pausar stream</button>
    <button id="btn-clear" type="button">Limpar tela</button>
    <button id="btn-export" type="button">Exportar JSON</button>
  </div>
</header>

<main>
  <section class="kpi-grid">
    <div class="kpi">
      <div class="kpi-label">Conexoes Ativas</div>
      <div id="kpi-sessions" class="kpi-value">0</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Streams SSE (/mcp)</div>
      <div id="kpi-sse" class="kpi-value">0</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Em Execucao Agora</div>
      <div id="kpi-inflight" class="kpi-value" style="color:var(--accent)">0</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Total Tool Calls</div>
      <div id="kpi-calls" class="kpi-value">0</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Erros / Falhas</div>
      <div id="kpi-errors" class="kpi-value" style="color:var(--err)">0</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Latencia Media</div>
      <div id="kpi-latency" class="kpi-value">0 ms</div>
    </div>
  </section>

  <!-- ABAS FORA DE CONTAINER: APENAS LINHA INFERIOR COM INDICADOR COLORIDO -->
  <nav class="tabs-bar" role="tablist" aria-label="Secoes de monitoramento">
    <div class="tabs-nav">
      <button id="tab-btn-transactions" class="tab-btn active" type="button" role="tab" aria-selected="true" aria-controls="tab-panel-transactions" data-tab="transactions">
        <span>Transacoes em Tempo Real</span>
        <span id="tx-count-badge" class="badge neutral">0</span>
      </button>
      <button id="tab-btn-sessions" class="tab-btn" type="button" role="tab" aria-selected="false" aria-controls="tab-panel-sessions" data-tab="sessions">
        <span>Conexoes e Sessoes MCP</span>
        <span id="session-count-badge" class="badge neutral">0</span>
      </button>
    </div>
  </nav>

  <!-- SECAO 1 (ABA TRANSACOES): FILTROS SEPARADOS + GRID DE LISTAGEM -->
  <section id="tab-panel-transactions" class="tab-panel active" role="tabpanel" aria-labelledby="tab-btn-transactions">
    <div class="filter-card">
      <div class="filter-controls">
        <select id="filter-category">
          <option value="">Todas categorias</option>
          <option value="tool_call">Tool Calls</option>
          <option value="mcp">Protocolo MCP</option>
          <option value="oauth">OAuth</option>
          <option value="auth">Autenticacao</option>
        </select>
        <select id="filter-status">
          <option value="">Todos status</option>
          <option value="running">Em execucao (running)</option>
          <option value="ok">Sucesso (ok)</option>
          <option value="error">Erro (error)</option>
        </select>
        <select id="filter-tool">
          <option value="">Todas ferramentas</option>
        </select>
        <input type="search" id="filter-search" placeholder="Filtrar por comando, path, IP, sessao..." style="min-width:260px;flex:1;" />
      </div>
    </div>

    <div class="grid-section">
      <div class="section-header">
        <div class="section-title">
          <span>Listagem de Transacoes</span>
        </div>
        <span class="muted" style="font-size:12px;">Clique em uma linha para expandir argumentos e preview da saida</span>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>Horario</th>
              <th>Status</th>
              <th>Evento / Ferramenta</th>
              <th>Sessao / Cliente</th>
              <th>IP</th>
              <th>Duracao</th>
              <th>Resumo / Argumentos</th>
            </tr>
          </thead>
          <tbody id="tx-tbody">
            <tr><td colspan="7" class="empty">Aguardando transacoes...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- SECAO 2 (ABA CONEXOES): FILTROS SEPARADOS + GRID DE LISTAGEM -->
  <section id="tab-panel-sessions" class="tab-panel" role="tabpanel" aria-labelledby="tab-btn-sessions">
    <div class="filter-card">
      <div class="filter-controls">
        <label class="muted" style="font-size:13px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="chk-active-only" /> Mostrar apenas sessoes ativas
        </label>
        <input type="search" id="filter-session-search" placeholder="Filtrar por Session ID, cliente, IP..." style="min-width:260px;flex:1;" />
      </div>
    </div>

    <div class="grid-section">
      <div class="section-header">
        <div class="section-title">
          <span>Listagem de Conexoes e Sessoes MCP</span>
        </div>
        <span class="muted" style="font-size:12px;">Clique em qualquer sessao para filtrar suas transacoes</span>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Session ID</th>
              <th>Cliente</th>
              <th>Auth</th>
              <th>IP Remoto</th>
              <th>SSE</th>
              <th>Em voo / Total / Erros</th>
              <th>Conectado em</th>
              <th>Ultima atividade</th>
            </tr>
          </thead>
          <tbody id="sessions-tbody">
            <tr><td colspan="9" class="empty">Nenhuma sessao registrada ainda.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</main>

<script>
(() => {
  const state = {
    activeTab: 'transactions',
    paused: false,
    sessions: new Map(),
    transactions: [],
    txById: new Map(),
    expandedTx: new Set(),
    knownTools: new Set(),
    serverStartedAt: null,
    stats: {},
  };

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  function switchTab(tabName) {
    state.activeTab = tabName === 'sessions' ? 'sessions' : 'transactions';
    const isTx = state.activeTab === 'transactions';
    el('tab-btn-transactions').classList.toggle('active', isTx);
    el('tab-btn-transactions').setAttribute('aria-selected', String(isTx));
    el('tab-btn-sessions').classList.toggle('active', !isTx);
    el('tab-btn-sessions').setAttribute('aria-selected', String(!isTx));
    el('tab-panel-transactions').classList.toggle('active', isTx);
    el('tab-panel-sessions').classList.toggle('active', !isTx);
    if (history.replaceState) {
      history.replaceState(null, '', isTx ? '#transacoes' : '#conexoes');
    }
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });

  if (location.hash === '#conexoes' || location.hash === '#sessions') {
    switchTab('sessions');
  }

  function fmtTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    return d.toLocaleTimeString('pt-BR', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function fmtUptime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
  }

  function summarizeTx(tx) {
    const isJobRunning = tx.result && (tx.result.job_status === 'running' || tx.result.exit_code === 'running');
    const hasNonZeroExit = tx.result && tx.result.exit_code !== undefined && tx.result.exit_code !== 0 && tx.result.exit_code !== 'running';
    const exitPrefix = isJobRunning
      ? '[job: running] '
      : hasNonZeroExit
        ? '[exit: ' + tx.result.exit_code + '] '
        : '';
    if (tx.summary) return exitPrefix + tx.summary;
    if (tx.error) return 'ERRO: ' + tx.error;
    if (tx.args && typeof tx.args === 'object') {
      if (tx.args.command) return exitPrefix + '$ ' + tx.args.command;
      if (tx.args.job_id) return exitPrefix + 'job: ' + tx.args.job_id + (tx.args.kill ? ' (kill)' : '');
      if (tx.args.pattern) return exitPrefix + 'rg ' + JSON.stringify(tx.args.pattern) + (tx.args.path ? ' em ' + tx.args.path : '');
      if (Array.isArray(tx.args.files)) return exitPrefix + tx.args.files.length + ' arquivo(s): ' + tx.args.files.map((f) => f && f.path ? f.path : '').filter(Boolean).join(', ');
      if (tx.args.path && Array.isArray(tx.args.edits)) return exitPrefix + tx.args.path + ' (' + tx.args.edits.length + ' edicoes)';
      if (tx.args.path) return exitPrefix + String(tx.args.path);
      if (tx.args.source && tx.args.destination) return tx.args.source + ' -> ' + tx.args.destination;
      if (tx.args.artifact_id) return 'artifact: ' + tx.args.artifact_id;
      const keys = Object.keys(tx.args);
      if (keys.length > 0) return exitPrefix + JSON.stringify(tx.args);
    }
    return exitPrefix;
  }

  function updateKpis(stats) {
    if (!stats) return;
    state.stats = stats;
    el('kpi-sessions').textContent = stats.activeSessions ?? 0;
    el('kpi-sse').textContent = stats.sseStreams ?? 0;
    el('kpi-inflight').textContent = stats.inFlightCalls ?? 0;
    el('kpi-calls').textContent = stats.totalToolCalls ?? 0;
    el('kpi-errors').textContent = stats.totalErrors ?? 0;
    el('kpi-latency').textContent = (stats.avgDurationMs ?? 0) + ' ms';
  }

  function syncToolFilter(tool) {
    if (!tool || state.knownTools.has(tool)) return;
    state.knownTools.add(tool);
    const sel = el('filter-tool');
    const opt = document.createElement('option');
    opt.value = tool;
    opt.textContent = tool;
    sel.appendChild(opt);
  }

  function renderSessions() {
    const activeOnly = el('chk-active-only').checked;
    const q = el('filter-session-search').value.trim().toLowerCase();
    const list = Array.from(state.sessions.values()).filter((s) => {
      if (activeOnly && s.status !== 'active') return false;
      if (q) {
        const hay = (s.sessionId + ' ' + (s.clientName || '') + ' ' + (s.clientId || '') + ' ' + (s.remoteIp || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    el('session-count-badge').textContent = list.length;
    const tbody = el('sessions-tbody');
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty">Nenhuma sessao para exibir.</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((s) => {
      const clientLabel = s.clientName
        ? esc(s.clientName) + (s.clientVersion ? ' v' + esc(s.clientVersion) : '')
        : esc(s.clientId);
      return '<tr class="sess-row" data-session-id="' + esc(s.sessionId) + '" title="Clique para filtrar transacoes desta sessao">' +
        '<td><span class="badge ' + esc(s.status) + '">' + esc(s.status) + '</span></td>' +
        '<td class="mono"><span class="link-chip">' + esc(s.sessionId) + '</span></td>' +
        '<td>' + clientLabel + '</td>' +
        '<td><span class="badge neutral">' + esc(s.authType) + '</span></td>' +
        '<td class="mono">' + esc(s.remoteIp) + '</td>' +
        '<td>' + (s.sseConnected ? '<span class="badge ok">conectado</span>' : '<span class="muted">nao</span>') + '</td>' +
        '<td class="mono">' + (s.inFlightCount || 0) + ' / ' + (s.totalCalls || 0) + ' / <span style="color:var(--err)">' + (s.errorCount || 0) + '</span></td>' +
        '<td class="mono muted">' + fmtTime(s.connectedAt) + '</td>' +
        '<td class="mono muted">' + fmtTime(s.lastActivityAt) + '</td>' +
      '</tr>';
    }).join('');
  }

  el('sessions-tbody').addEventListener('click', (ev) => {
    const row = ev.target.closest('tr.sess-row');
    if (!row) return;
    const sessionId = row.getAttribute('data-session-id');
    if (!sessionId) return;
    el('filter-search').value = sessionId;
    renderTransactions();
    switchTab('transactions');
  });

  function matchesFilter(tx) {
    const cat = el('filter-category').value;
    const st = el('filter-status').value;
    const tool = el('filter-tool').value;
    const q = el('filter-search').value.trim().toLowerCase();
    if (cat && tx.category !== cat) return false;
    if (st && tx.status !== st) return false;
    if (tool && tx.tool !== tool) return false;
    if (q) {
      const hay = JSON.stringify(tx).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function renderTransactions() {
    const filtered = state.transactions.filter(matchesFilter);
    el('tx-count-badge').textContent = filtered.length;
    const tbody = el('tx-tbody');
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma transacao corresponde aos filtros.</td></tr>';
      return;
    }
    const now = Date.now();
    tbody.innerHTML = filtered.slice(0, 300).map((tx) => {
      const isOpen = state.expandedTx.has(tx.id);
      const dur = tx.status === 'running'
        ? '<span class="mono" style="color:var(--accent)" data-running-since="' + tx.startedAtMs + '">' + Math.max(0, Math.round((now - tx.startedAtMs) / 100) / 10) + 's…</span>'
        : '<span class="mono">' + (tx.durationMs ?? 0) + ' ms</span>';
      const title = tx.tool ? '<strong>' + esc(tx.tool) + '</strong> <span class="muted mono">(' + esc(tx.event) + ')</span>' : '<span class="mono">' + esc(tx.event) + '</span>';
      const sessShort = tx.sessionId ? esc(String(tx.sessionId).slice(0, 8)) + '…' : '-';
      const clientStr = tx.clientId ? esc(tx.clientId) : '';
      const summary = summarizeTx(tx);
      const resultBlock = tx.result ? JSON.stringify(tx.result, null, 2) : (tx.error ? tx.error : '(aguardando conclusao)');
      const previewBlock = tx.result && tx.result.preview ? tx.result.preview : null;
      const isJobRunning = tx.status === 'ok' && tx.result && (tx.result.job_status === 'running' || tx.result.exit_code === 'running');
      const hasNonZeroExit = tx.status === 'ok' && tx.result && tx.result.exit_code !== undefined && tx.result.exit_code !== 0 && tx.result.exit_code !== 'running';
      const extraStatusBadge = isJobRunning
        ? ' <span class="badge running" title="Job em background ainda em execucao">job running</span>'
        : hasNonZeroExit
          ? ' <span class="badge warn" title="Comando encerrou com exit_code diferente de zero">exit ' + esc(tx.result.exit_code) + '</span>'
          : '';

      return '<tr class="tx-row" data-tx-id="' + esc(tx.id) + '">' +
        '<td class="mono muted">' + fmtTime(tx.timestamp) + '</td>' +
        '<td><span class="badge ' + esc(tx.status) + '">' + esc(tx.status) + '</span>' + extraStatusBadge + '</td>' +
        '<td>' + title + '</td>' +
        '<td class="mono" title="' + esc(tx.sessionId || '') + '">' + sessShort + (clientStr ? ' <span class="muted">(' + clientStr + ')</span>' : '') + '</td>' +
        '<td class="mono">' + esc(tx.remoteIp || '-') + '</td>' +
        '<td>' + dur + '</td>' +
        '<td><span class="truncate mono">' + esc(summary) + '</span></td>' +
      '</tr>' +
      '<tr class="tx-detail ' + (isOpen ? 'open' : '') + '" id="detail-' + esc(tx.id) + '">' +
        '<td colspan="7">' +
          '<div class="detail-box">' +
            '<div><div class="muted" style="font-size:12px;">Argumentos (sanitizados)</div><pre>' + esc(JSON.stringify(tx.args ?? {}, null, 2)) + '</pre></div>' +
            '<div><div class="muted" style="font-size:12px;">Resultado / Erro</div><pre>' + esc(resultBlock) + '</pre>' +
              (previewBlock ? '<div class="muted" style="font-size:12px;margin-top:8px;">Preview da saida</div><pre>' + esc(previewBlock) + '</pre>' : '') +
            '</div>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  el('tx-tbody').addEventListener('click', (ev) => {
    const row = ev.target.closest('tr.tx-row');
    if (!row) return;
    const id = row.getAttribute('data-tx-id');
    if (!id) return;
    if (state.expandedTx.has(id)) state.expandedTx.delete(id);
    else state.expandedTx.add(id);
    const detail = el('detail-' + id);
    if (detail) detail.classList.toggle('open');
  });

  ['filter-category', 'filter-status', 'filter-tool', 'filter-search'].forEach((id) => {
    el(id).addEventListener('input', renderTransactions);
    el(id).addEventListener('change', renderTransactions);
  });
  el('chk-active-only').addEventListener('change', renderSessions);
  el('filter-session-search').addEventListener('input', renderSessions);

  el('btn-pause').addEventListener('click', () => {
    state.paused = !state.paused;
    const btn = el('btn-pause');
    const dot = el('live-dot');
    btn.classList.toggle('active', state.paused);
    btn.textContent = state.paused ? 'Retomar stream' : 'Pausar stream';
    dot.classList.toggle('paused', state.paused);
    if (!state.paused) {
      renderSessions();
      renderTransactions();
    }
  });

  el('btn-clear').addEventListener('click', () => {
    state.transactions = [];
    state.txById.clear();
    state.expandedTx.clear();
    renderTransactions();
  });

  el('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({
      exportedAt: new Date().toISOString(),
      stats: state.stats,
      sessions: Array.from(state.sessions.values()),
      transactions: state.transactions,
    }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mcp-logs-' + Date.now() + '.json';
    a.click();
  });

  function connectSse() {
    const es = new EventSource('/logs/stream');
    const dot = el('live-dot');
    const status = el('conn-status');

    es.onopen = () => {
      dot.classList.remove('disconnected');
      status.textContent = 'Ao vivo (SSE conectado)';
    };

    es.onerror = () => {
      dot.classList.add('disconnected');
      status.textContent = 'Reconectando ao stream...';
    };

    es.addEventListener('snapshot', (ev) => {
      const snap = JSON.parse(ev.data);
      state.serverStartedAt = snap.server?.startedAt ? Date.parse(snap.server.startedAt) : Date.now();
      state.sessions.clear();
      for (const s of snap.sessions || []) state.sessions.set(s.sessionId, s);
      state.transactions = snap.transactions || [];
      state.txById.clear();
      for (const tx of state.transactions) {
        state.txById.set(tx.id, tx);
        syncToolFilter(tx.tool);
      }
      updateKpis(snap.stats);
      if (!state.paused) {
        renderSessions();
        renderTransactions();
      }
    });

    es.addEventListener('session', (ev) => {
      const data = JSON.parse(ev.data);
      if (data.session) state.sessions.set(data.session.sessionId, data.session);
      updateKpis(data.stats);
      if (!state.paused) renderSessions();
    });

    es.addEventListener('transaction', (ev) => {
      const data = JSON.parse(ev.data);
      const tx = data.transaction;
      if (tx) {
        syncToolFilter(tx.tool);
        if (state.txById.has(tx.id)) {
          Object.assign(state.txById.get(tx.id), tx);
        } else {
          state.transactions.unshift(tx);
          state.txById.set(tx.id, tx);
          if (state.transactions.length > 500) {
            const old = state.transactions.pop();
            if (old) state.txById.delete(old.id);
          }
        }
      }
      updateKpis(data.stats);
      if (!state.paused) renderTransactions();
    });
  }

  setInterval(() => {
    if (state.serverStartedAt) {
      const sec = Math.max(0, Math.floor((Date.now() - state.serverStartedAt) / 1000));
      el('uptime-label').textContent = 'uptime: ' + fmtUptime(sec);
    }
    if (!state.paused) {
      const runningNodes = document.querySelectorAll('[data-running-since]');
      const now = Date.now();
      runningNodes.forEach((node) => {
        const started = Number(node.getAttribute('data-running-since'));
        if (started) node.textContent = Math.max(0, (now - started) / 1000).toFixed(1) + 's…';
      });
    }
  }, 200);

  connectSse();
})();
</script>
</body>
</html>`;
}
