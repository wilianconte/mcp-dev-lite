import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const SENSITIVE_KEY = /(authorization|password|passwd|token|secret|api[_-]?key|credential|cookie)/i;
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const DEFAULT_MAX_AUDIT_FILE_BYTES = 20 * 1024 * 1024;

function redactSecretsInString(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s\"']+/gi, "$1[REDACTED]")
    .replace(
      /((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&;]+)/gi,
      "$1[REDACTED]",
    );
}

export function truncateString(value: string, maxChars = MAX_STRING_CHARS): string {
  const redacted = redactSecretsInString(value);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}...[truncated ${redacted.length - maxChars} chars]`;
}

export function sanitizeAuditValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeAuditValue(item));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    return items;
  }
  if (typeof value === "object") {
    const recordObj = value as Record<string, unknown>;
    const keys = Object.keys(recordObj);
    const limit = Math.min(keys.length, MAX_OBJECT_KEYS);
    const result: Record<string, unknown> = {};
    for (let i = 0; i < limit; i += 1) {
      const childKey = keys[i];
      result[childKey] = sanitizeAuditValue(recordObj[childKey], childKey);
    }
    if (keys.length > MAX_OBJECT_KEYS) {
      result.__truncated_keys = true;
    }
    return result;
  }
  return String(value);
}

export interface ToolResultSummary {
  is_error: boolean;
  content_types: string[];
  text_chars: number;
  image_base64_chars: number;
  exit_code?: number | string;
  job_status?: string;
  timed_out?: boolean;
  preview?: string;
}

export function summarizeToolResult(result: CallToolResult, includePreview = false): ToolResultSummary {
  let textChars = 0;
  let imageBase64Chars = 0;
  let exitCode: number | string | undefined;
  let jobStatus: string | undefined;
  let timedOut = false;
  const contentTypes: string[] = [];
  const textSnippets: string[] = [];
  for (const item of result.content ?? []) {
    contentTypes.push(item.type);
    if (item.type === "text") {
      textChars += item.text.length;
      if (jobStatus === undefined) {
        const statusMatch = item.text.match(/^status:\s*(running|completed|timed_out|output_limit|killed)\b/m);
        if (statusMatch) {
          jobStatus = statusMatch[1];
        }
      }
      if (exitCode === undefined) {
        const match = item.text.match(/^exit[_ ]code:\s*([^\s(]+)(?:\s*\(([^)]+)\))?/m);
        if (match) {
          const rawCode = match[1];
          if (rawCode === "running") {
            if (!jobStatus) jobStatus = "running";
          } else {
            exitCode = /^-?\d+$/.test(rawCode) ? Number(rawCode) : rawCode;
            if (rawCode === "timeout" || (match[2] && match[2].includes("timeout"))) {
              timedOut = true;
            }
          }
        }
      }
      if (includePreview && textSnippets.length < 3) {
        textSnippets.push(item.text);
      }
    }
    if (item.type === "image") imageBase64Chars += item.data.length;
  }
  const summary: ToolResultSummary = {
    is_error: result.isError === true,
    content_types: contentTypes,
    text_chars: textChars,
    image_base64_chars: imageBase64Chars,
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(jobStatus !== undefined ? { job_status: jobStatus } : {}),
    ...(timedOut ? { timed_out: true } : {}),
  };
  if (includePreview && textSnippets.length > 0) {
    summary.preview = truncateString(textSnippets.join("\n"), 1_200);
  }
  return summary;
}

export interface ToolAuditEvent {
  tool: string;
  args: Record<string, unknown>;
  sessionId?: string;
  requestId?: string | number;
  clientId?: string;
  remoteIp?: string;
  result?: CallToolResult;
  error?: unknown;
  startedAtMs: number;
}

export function auditLogPath(): string | null {
  const configured = process.env.MCP_AUDIT_LOG_PATH?.trim();
  if (configured?.toLowerCase() === "false") return null;
  if (configured) {
    return path.resolve(configured.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  }
  const dataDir = process.env.MCP_DATA_DIR?.trim();
  if (dataDir) {
    return path.join(path.resolve(dataDir), "audit.jsonl");
  }
  return null;
}

function shouldWriteStderr(): boolean {
  return process.env.MCP_AUDIT_STDERR?.toLowerCase() !== "false";
}

// Cache de caminhos já preparados (mkdir 0700 + chmod 0600) e tamanho estimado em bytes para rotacao sem stat extra por chamada.
const preparedAuditPaths = new Set<string>();
const auditFileSizes = new Map<string, number>();

export async function auditToolCall(event: ToolAuditEvent): Promise<void> {
  const finishedAtMs = Date.now();
  const record = {
    timestamp: new Date(finishedAtMs).toISOString(),
    event: "mcp.tool_call",
    tool: event.tool,
    session_id: event.sessionId ?? null,
    request_id: event.requestId ?? null,
    client_id: event.clientId ?? null,
    remote_ip: event.remoteIp ?? null,
    duration_ms: Math.max(0, finishedAtMs - event.startedAtMs),
    args: sanitizeAuditValue(event.args),
    ...(event.result ? { result: summarizeToolResult(event.result, false) } : {}),
    ...(event.error
      ? { error: truncateString(event.error instanceof Error ? event.error.message : String(event.error)) }
      : {}),
  };
  const line = JSON.stringify(record);

  if (shouldWriteStderr()) console.error(`[audit] ${line}`);

  const target = auditLogPath();
  if (!target) return;
  try {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    const maxAuditBytes = Number(process.env.MCP_AUDIT_MAX_BYTES ?? DEFAULT_MAX_AUDIT_FILE_BYTES);

    if (!preparedAuditPaths.has(target)) {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const existingStat = await stat(target).catch(() => null);
      auditFileSizes.set(target, existingStat?.size ?? 0);
      preparedAuditPaths.add(target);
    }

    let currentBytes = auditFileSizes.get(target) ?? 0;
    if (Number.isFinite(maxAuditBytes) && maxAuditBytes > 0 && currentBytes > 0 && currentBytes + lineBytes > maxAuditBytes) {
      await rename(target, `${target}.1`).catch(() => undefined);
      currentBytes = 0;
    }

    await appendFile(target, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    if (currentBytes === 0) {
      await chmod(target, 0o600).catch(() => undefined);
    }
    auditFileSizes.set(target, currentBytes + lineBytes);
  } catch (err) {
    preparedAuditPaths.delete(target);
    auditFileSizes.delete(target);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[audit] falha ao gravar ${target}: ${message}`);
  }
}
