import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_OUTPUT_PAGE_CHARS = 30_000;
const MAX_ARTIFACTS = 50;
const ARTIFACT_TTL_MS = 60 * 60 * 1000;
const STORE_DIR = path.join(os.tmpdir(), "mcp-dev-agent-output");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StoredTextArtifact {
  id: string;
  path: string;
  createdAt: number;
  chars: number;
  bytes: number;
}

const MAX_MEMORY_CACHE_ARTIFACTS = 5;
const MAX_MEMORY_CACHE_CHARS = 2_000_000;
const PRUNE_READ_INTERVAL_MS = 30_000;

const memoryCache = new Map<string, { text: string; bytes: number; mtimeMs: number }>();
let lastPruneAtMs = 0;
let storeDirInitialized = false;

async function ensureStoreDir(): Promise<void> {
  if (storeDirInitialized) return;
  await fs.mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(STORE_DIR, 0o700).catch(() => undefined);
  storeDirInitialized = true;
}

async function listArtifactFiles(): Promise<Array<{ id: string; path: string; mtimeMs: number }>> {
  await ensureStoreDir();
  let entries;
  try {
    entries = await fs.readdir(STORE_DIR, { withFileTypes: true });
  } catch {
    storeDirInitialized = false;
    await ensureStoreDir();
    entries = await fs.readdir(STORE_DIR, { withFileTypes: true });
  }
  const candidates = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".txt"));
  const stats = await Promise.all(
    candidates.map(async (entry) => {
      const target = path.join(STORE_DIR, entry.name);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat?.isFile()) return null;
      return { id: entry.name.slice(0, -4), path: target, mtimeMs: stat.mtimeMs };
    }),
  );
  return stats.filter((item): item is { id: string; path: string; mtimeMs: number } => item !== null);
}

async function pruneArtifacts(reserveSlots = 0, force = false): Promise<void> {
  const now = Date.now();
  if (!force && reserveSlots === 0 && now - lastPruneAtMs < PRUNE_READ_INTERVAL_MS) {
    return;
  }
  lastPruneAtMs = now;
  const files = await listArtifactFiles();
  const valid: Array<{ id: string; path: string; mtimeMs: number }> = [];
  const toDelete: Array<{ id: string; path: string }> = [];

  for (const file of files) {
    if (now - file.mtimeMs > ARTIFACT_TTL_MS) {
      toDelete.push(file);
    } else {
      valid.push(file);
    }
  }

  const keep = Math.max(0, MAX_ARTIFACTS - reserveSlots);
  if (valid.length > keep) {
    const oldest = valid.sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, valid.length - keep);
    toDelete.push(...oldest);
  }

  if (toDelete.length > 0) {
    await Promise.all(
      toDelete.map((file) => {
        memoryCache.delete(file.id);
        return fs.rm(file.path, { force: true }).catch(() => undefined);
      }),
    );
  }
}

function cacheArtifactInMemory(id: string, text: string, bytes: number, mtimeMs: number): void {
  if (text.length > MAX_MEMORY_CACHE_CHARS) return;
  if (memoryCache.has(id)) memoryCache.delete(id);
  memoryCache.set(id, { text, bytes, mtimeMs });
  while (memoryCache.size > MAX_MEMORY_CACHE_ARTIFACTS) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    memoryCache.delete(oldestKey);
  }
}

export async function storeTextArtifact(text: string): Promise<StoredTextArtifact> {
  await ensureStoreDir();
  await pruneArtifacts(1, true);
  const id = randomUUID();
  const target = path.join(STORE_DIR, `${id}.txt`);
  try {
    await fs.writeFile(target, text, { encoding: "utf8", mode: 0o600 });
  } catch {
    storeDirInitialized = false;
    await ensureStoreDir();
    await fs.writeFile(target, text, { encoding: "utf8", mode: 0o600 });
  }
  await fs.chmod(target, 0o600).catch(() => undefined);
  const bytes = Buffer.byteLength(text, "utf8");
  const createdAt = Date.now();
  cacheArtifactInMemory(id, text, bytes, createdAt);
  return {
    id,
    path: target,
    createdAt,
    chars: text.length,
    bytes,
  };
}

export async function readTextArtifact(
  id: string,
  offset = 0,
  limit = DEFAULT_OUTPUT_PAGE_CHARS,
): Promise<{ text: string; offset: number; nextOffset: number | null; totalChars: number; totalBytes: number }> {
  if (!UUID_PATTERN.test(id)) throw new Error(`artifact_id invalido: ${id}`);
  await pruneArtifacts(0, false);

  const now = Date.now();
  const cached = memoryCache.get(id);
  if (cached) {
    if (now - cached.mtimeMs > ARTIFACT_TTL_MS) {
      memoryCache.delete(id);
    } else {
      const safeOffset = Math.min(Math.max(0, offset), cached.text.length);
      const safeLimit = Math.min(Math.max(1, limit), DEFAULT_OUTPUT_PAGE_CHARS);
      const end = Math.min(cached.text.length, safeOffset + safeLimit);
      return {
        text: cached.text.slice(safeOffset, end),
        offset: safeOffset,
        nextOffset: end < cached.text.length ? end : null,
        totalChars: cached.text.length,
        totalBytes: cached.bytes,
      };
    }
  }

  const target = path.join(STORE_DIR, `${id}.txt`);
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`artifact_id desconhecido ou expirado: ${id}. Saidas de comando ficam disponiveis por ate 1 hora.`);
  }
  if (now - stat.mtimeMs > ARTIFACT_TTL_MS) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    throw new Error(`artifact_id expirado: ${id}. Saidas de comando ficam disponiveis por ate 1 hora.`);
  }

  const content = await fs.readFile(target, "utf8");
  cacheArtifactInMemory(id, content, stat.size, stat.mtimeMs);
  const safeOffset = Math.min(Math.max(0, offset), content.length);
  const safeLimit = Math.min(Math.max(1, limit), DEFAULT_OUTPUT_PAGE_CHARS);
  const end = Math.min(content.length, safeOffset + safeLimit);
  return {
    text: content.slice(safeOffset, end),
    offset: safeOffset,
    nextOffset: end < content.length ? end : null,
    totalChars: content.length,
    totalBytes: stat.size,
  };
}
