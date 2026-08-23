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

async function ensureStoreDir(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(STORE_DIR, 0o700).catch(() => undefined);
}

async function listArtifactFiles(): Promise<Array<{ path: string; mtimeMs: number }>> {
  await ensureStoreDir();
  const entries = await fs.readdir(STORE_DIR, { withFileTypes: true });
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
    const target = path.join(STORE_DIR, entry.name);
    const stat = await fs.stat(target).catch(() => null);
    if (stat?.isFile()) files.push({ path: target, mtimeMs: stat.mtimeMs });
  }
  return files;
}

async function pruneArtifacts(reserveSlots = 0): Promise<void> {
  const now = Date.now();
  const files = await listArtifactFiles();
  const valid: Array<{ path: string; mtimeMs: number }> = [];

  for (const file of files) {
    if (now - file.mtimeMs > ARTIFACT_TTL_MS) {
      await fs.rm(file.path, { force: true }).catch(() => undefined);
    } else {
      valid.push(file);
    }
  }

  const keep = Math.max(0, MAX_ARTIFACTS - reserveSlots);
  if (valid.length <= keep) return;
  const oldest = valid.sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, valid.length - keep);
  for (const file of oldest) await fs.rm(file.path, { force: true }).catch(() => undefined);
}

export async function storeTextArtifact(text: string): Promise<StoredTextArtifact> {
  await ensureStoreDir();
  await pruneArtifacts(1);
  const id = randomUUID();
  const target = path.join(STORE_DIR, `${id}.txt`);
  await fs.writeFile(target, text, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(target, 0o600).catch(() => undefined);
  const stat = await fs.stat(target);
  return {
    id,
    path: target,
    createdAt: stat.mtimeMs,
    chars: text.length,
    bytes: stat.size,
  };
}

export async function readTextArtifact(
  id: string,
  offset = 0,
  limit = DEFAULT_OUTPUT_PAGE_CHARS,
): Promise<{ text: string; offset: number; nextOffset: number | null; totalChars: number; totalBytes: number }> {
  if (!UUID_PATTERN.test(id)) throw new Error(`artifact_id invalido: ${id}`);
  await pruneArtifacts();
  const target = path.join(STORE_DIR, `${id}.txt`);
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`artifact_id desconhecido ou expirado: ${id}. Saidas de comando ficam disponiveis por ate 1 hora.`);
  }
  if (Date.now() - stat.mtimeMs > ARTIFACT_TTL_MS) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    throw new Error(`artifact_id expirado: ${id}. Saidas de comando ficam disponiveis por ate 1 hora.`);
  }

  const content = await fs.readFile(target, "utf8");
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
