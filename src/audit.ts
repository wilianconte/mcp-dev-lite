import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const SENSITIVE_KEY = /(authorization|password|passwd|token|secret|api[_-]?key|credential|cookie)/i;
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;

function redactSecretsInString(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s\"']+/gi, "$1[REDACTED]")
    .replace(
      /((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&;]+)/gi,
      "$1[REDACTED]",
    );
}

function truncateString(value: string): string {
  const redacted = redactSecretsInString(value);
  if (redacted.length <= MAX_STRING_CHARS) return redacted;
  return `${redacted.slice(0, MAX_STRING_CHARS)}...[truncated ${redacted.length - MAX_STRING_CHARS} chars]`;
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
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of entries) {
      result[childKey] = sanitizeAuditValue(childValue, childKey);
    }
    if (Object.keys(value as Record<string, unknown>).length > MAX_OBJECT_KEYS) {
      result.__truncated_keys = true;
    }
    return result;
  }
  return String(value);
}

function contentSummary(result: CallToolResult): Record<string, unknown> {
  let textChars = 0;
  let imageBase64Chars = 0;
  const contentTypes: string[] = [];
  for (const item of result.content ?? []) {
    contentTypes.push(item.type);
    if (item.type === "text") textChars += item.text.length;
    if (item.type === "image") imageBase64Chars += item.data.length;
  }
  return {
    is_error: result.isError === true,
    content_types: contentTypes,
    text_chars: textChars,
    image_base64_chars: imageBase64Chars,
  };
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

function auditLogPath(): string | null {
  const configured = process.env.MCP_AUDIT_LOG_PATH?.trim();
  if (!configured) return null;
  return path.resolve(configured.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
}

function shouldWriteStderr(): boolean {
  return process.env.MCP_AUDIT_STDERR?.toLowerCase() !== "false";
}

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
    ...(event.result ? { result: contentSummary(event.result) } : {}),
    ...(event.error
      ? { error: truncateString(event.error instanceof Error ? event.error.message : String(event.error)) }
      : {}),
  };
  const line = JSON.stringify(record);

  if (shouldWriteStderr()) console.error(`[audit] ${line}`);

  const target = auditLogPath();
  if (!target) return;
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await appendFile(target, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(target, 0o600).catch(() => undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[audit] falha ao gravar ${target}: ${message}`);
  }
}
