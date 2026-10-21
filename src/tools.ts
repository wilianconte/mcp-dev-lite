import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_OUTPUT_PAGE_CHARS,
  readTextArtifact,
  storeTextArtifact,
} from "./output-store.js";

const MAX_PREVIEW_CHARS = DEFAULT_OUTPUT_PAGE_CHARS;
const PREVIEW_EDGE_CHARS = 14_000;
const DEFAULT_DIRECTORY_LIMIT = 200;
const MAX_DIRECTORY_LIMIT = 1_000;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8_192;
const DEFAULT_COMMAND_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const MAX_STORED_JOBS = 200;
const JOB_RETENTION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SEARCH_IGNORE_DIRS = ["node_modules", ".git", ".next", "dist", "build", "coverage"];

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

interface CommandExecution {
  exitCode: number | string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  maxBufferExceeded: boolean;
  errorMessage?: string;
}

function configuredPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} deve ser um numero positivo.`);
  return value;
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    // O processo/grupo pode ja ter encerrado entre a verificacao e o sinal.
  }
}

function executeCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandExecution> {
  return new Promise((resolve) => {
    let timedOut = false;
    let maxBufferExceeded = false;
    let spawnError: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const maxBuffer = configuredPositiveNumber("MCP_COMMAND_MAX_BUFFER_BYTES", DEFAULT_COMMAND_MAX_BUFFER_BYTES);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;

    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const terminateGroup = (): void => {
      killProcessGroup(child.pid, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 1_000);
        killTimer.unref();
      }
    };

    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      if (maxBufferExceeded) return;
      const remaining = maxBuffer - capturedBytes;
      if (remaining <= 0) {
        maxBufferExceeded = true;
        terminateGroup();
        return;
      }
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        capturedBytes += chunk.length;
        return;
      }
      chunks.push(chunk.subarray(0, remaining));
      capturedBytes += remaining;
      maxBufferExceeded = true;
      terminateGroup();
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderrChunks, chunk));
    child.on("error", (err) => {
      spawnError = err.message;
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateGroup();
    }, timeoutMs);
    timeoutTimer.unref();

    child.on("close", (code, signal) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut || maxBufferExceeded) killProcessGroup(child.pid, "SIGKILL");
      const errorMessage = spawnError ?? (signal && !timedOut && !maxBufferExceeded ? `Processo encerrado por sinal ${signal}.` : undefined);
      resolve({
        exitCode: timedOut ? "timeout" : maxBufferExceeded ? "output_limit" : code ?? "desconhecido",
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        maxBufferExceeded,
        errorMessage,
      });
    });
  });
}

interface BackgroundJob {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  startedAtMs: number;
  finishedAtMs?: number;
  status: "running" | "completed" | "timed_out" | "output_limit" | "killed";
  exitCode: number | string | null;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  capturedBytes: number;
  timedOut: boolean;
  maxBufferExceeded: boolean;
  killedByUser: boolean;
  errorMessage?: string;
  waiters: Set<() => void>;
  terminate: (byUser?: boolean) => void;
}

const backgroundJobs = new Map<string, BackgroundJob>();

function pruneBackgroundJobs(): void {
  const now = Date.now();
  for (const [id, job] of backgroundJobs.entries()) {
    if (job.status !== "running" && job.finishedAtMs && now - job.finishedAtMs > JOB_RETENTION_MS) {
      backgroundJobs.delete(id);
    }
  }
  if (backgroundJobs.size <= MAX_STORED_JOBS) return;
  const finished = Array.from(backgroundJobs.values())
    .filter((j) => j.status !== "running")
    .sort((a, b) => (a.finishedAtMs ?? 0) - (b.finishedAtMs ?? 0));
  while (backgroundJobs.size > MAX_STORED_JOBS && finished.length > 0) {
    const oldest = finished.shift()!;
    backgroundJobs.delete(oldest.id);
  }
}

function startBackgroundJob(command: string, cwd: string, timeoutMs: number): BackgroundJob {
  pruneBackgroundJobs();
  const id = randomUUID();
  const maxBuffer = configuredPositiveNumber("MCP_COMMAND_MAX_BUFFER_BYTES", DEFAULT_COMMAND_MAX_BUFFER_BYTES);
  let killTimer: NodeJS.Timeout | undefined;

  const child = spawn("/bin/bash", ["-c", command], {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const job: BackgroundJob = {
    id,
    command,
    cwd,
    pid: child.pid,
    startedAtMs: Date.now(),
    status: "running",
    exitCode: null,
    stdoutChunks: [],
    stderrChunks: [],
    capturedBytes: 0,
    timedOut: false,
    maxBufferExceeded: false,
    killedByUser: false,
    waiters: new Set(),
    terminate: (byUser = false) => {
      if (job.status !== "running") return;
      if (byUser) job.killedByUser = true;
      killProcessGroup(child.pid, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 1_000);
        killTimer.unref();
      }
    },
  };

  const capture = (chunks: Buffer[], chunk: Buffer): void => {
    if (job.maxBufferExceeded) return;
    const remaining = maxBuffer - job.capturedBytes;
    if (remaining <= 0) {
      job.maxBufferExceeded = true;
      job.terminate(false);
      return;
    }
    if (chunk.length <= remaining) {
      chunks.push(chunk);
      job.capturedBytes += chunk.length;
      return;
    }
    chunks.push(chunk.subarray(0, remaining));
    job.capturedBytes += remaining;
    job.maxBufferExceeded = true;
    job.terminate(false);
  };

  child.stdout.on("data", (chunk: Buffer) => capture(job.stdoutChunks, chunk));
  child.stderr.on("data", (chunk: Buffer) => capture(job.stderrChunks, chunk));
  child.on("error", (err) => {
    job.errorMessage = err.message;
  });

  const timeoutTimer = setTimeout(() => {
    job.timedOut = true;
    job.terminate(false);
  }, timeoutMs);
  timeoutTimer.unref();

  child.on("close", (code, signal) => {
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    if (job.timedOut || job.maxBufferExceeded || job.killedByUser) {
      killProcessGroup(child.pid, "SIGKILL");
    }
    job.finishedAtMs = Date.now();
    if (job.killedByUser) {
      job.status = "killed";
      job.exitCode = "killed";
    } else if (job.timedOut) {
      job.status = "timed_out";
      job.exitCode = "timeout";
    } else if (job.maxBufferExceeded) {
      job.status = "output_limit";
      job.exitCode = "output_limit";
    } else {
      job.status = "completed";
      job.exitCode = code ?? "desconhecido";
      if (signal && !job.errorMessage) {
        job.errorMessage = `Processo encerrado por sinal ${signal}.`;
      }
    }
    for (const notify of job.waiters) notify();
    job.waiters.clear();
  });

  backgroundJobs.set(id, job);
  return job;
}

function waitForJob(job: BackgroundJob, waitMs: number): Promise<void> {
  if (job.status !== "running" || waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const onDone = () => {
      clearTimeout(timer);
      job.waiters.delete(onDone);
      resolve();
    };
    const timer = setTimeout(() => {
      job.waiters.delete(onDone);
      resolve();
    }, waitMs);
    timer.unref();
    job.waiters.add(onDone);
  });
}

async function formatJobResult(job: BackgroundJob, stdoutOffset = 0): Promise<CallToolResult> {
  const fullStdout = Buffer.concat(job.stdoutChunks).toString("utf8");
  const fullStderr = Buffer.concat(job.stderrChunks).toString("utf8");
  const safeOffset = Math.min(Math.max(0, stdoutOffset), fullStdout.length);
  const slicedStdout = fullStdout.slice(safeOffset);
  const elapsedMs = (job.finishedAtMs ?? Date.now()) - job.startedAtMs;
  const parts = [
    `job_id: ${job.id}`,
    `status: ${job.status}`,
    job.exitCode !== null
      ? `exit_code: ${job.exitCode}${job.timedOut ? " (timeout; grupo de processos encerrado)" : ""}`
      : "exit_code: running",
    `pid: ${job.pid ?? "desconhecido"}`,
    `elapsed_ms: ${elapsedMs}`,
    `stdout_offset: ${safeOffset}`,
    `next_offset: ${fullStdout.length}`,
    `total_stdout_chars: ${fullStdout.length}`,
    job.status === "running" && fullStdout.length > 0
      ? `poll_hint: passe offset=${fullStdout.length} no proximo poll_command para ler apenas novas linhas de stdout`
      : "",
    job.maxBufferExceeded
      ? `output_limit_exceeded: true (MCP_COMMAND_MAX_BUFFER_BYTES=${configuredPositiveNumber("MCP_COMMAND_MAX_BUFFER_BYTES", DEFAULT_COMMAND_MAX_BUFFER_BYTES)})`
      : "",
    slicedStdout ? `stdout:\n${slicedStdout}` : "stdout: (vazio)",
    fullStderr ? `stderr:\n${fullStderr}` : "",
    job.errorMessage ? `error_message:\n${job.errorMessage}` : "",
  ].filter(Boolean);
  return commandResult(parts.join("\n"));
}

function executeRipgrep(rgArgs: string[], cwd: string, timeoutMs = 30_000): Promise<CommandExecution> {
  return new Promise((resolve) => {
    let timedOut = false;
    let maxBufferExceeded = false;
    let spawnError: string | undefined;
    const maxBuffer = configuredPositiveNumber("MCP_COMMAND_MAX_BUFFER_BYTES", DEFAULT_COMMAND_MAX_BUFFER_BYTES);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;

    const child = spawn("rg", rgArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      if (maxBufferExceeded) return;
      const remaining = maxBuffer - capturedBytes;
      if (remaining <= 0) {
        maxBufferExceeded = true;
        child.kill("SIGTERM");
        return;
      }
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        capturedBytes += chunk.length;
        return;
      }
      chunks.push(chunk.subarray(0, remaining));
      capturedBytes += remaining;
      maxBufferExceeded = true;
      child.kill("SIGTERM");
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderrChunks, chunk));
    child.on("error", (err) => {
      spawnError = err.message;
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timeoutTimer.unref();

    child.on("close", (code) => {
      clearTimeout(timeoutTimer);
      resolve({
        exitCode: timedOut ? "timeout" : maxBufferExceeded ? "output_limit" : code ?? "desconhecido",
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        maxBufferExceeded,
        errorMessage: spawnError,
      });
    });
  });
}

function previewText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_PREVIEW_CHARS) return { text, truncated: false };
  const omitted = text.length - PREVIEW_EDGE_CHARS * 2;
  return {
    text:
      `${text.slice(0, PREVIEW_EDGE_CHARS)}\n\n` +
      `[... ${omitted} caracteres omitidos nesta visualizacao ...]\n\n` +
      text.slice(-PREVIEW_EDGE_CHARS),
    truncated: true,
  };
}

/** Resolve ~ e caminhos relativos para um caminho absoluto. */
function resolvePath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

async function commandResult(fullOutput: string): Promise<CallToolResult> {
  if (fullOutput.length <= MAX_PREVIEW_CHARS) return textResult(fullOutput);
  const artifact = await storeTextArtifact(fullOutput);
  const preview = previewText(fullOutput).text;
  return textResult(
    `${preview}\n\n` +
      `[saida completa preservada]\n` +
      `artifact_id: ${artifact.id}\n` +
      `total_chars: ${artifact.chars}\n` +
      `total_bytes: ${artifact.bytes}\n` +
      `Use read_command_output com artifact_id e offset para ler qualquer trecho sem perda.`,
  );
}

interface ImageInfo {
  mimeType: string;
  width?: number;
  height?: number;
}

function detectImage(buffer: Buffer): ImageInfo | null {
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return {
      mimeType: "image/png",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg" };
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return buffer.length >= 10
      ? { mimeType: "image/gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
      : { mimeType: "image/gif" };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mimeType: "image/webp" };
  }
  return null;
}

const entryCollator = new Intl.Collator();

function countLines(text: string): number {
  let lines = 1;
  let pos = -1;
  while ((pos = text.indexOf("\n", pos + 1)) !== -1) {
    lines += 1;
  }
  return lines;
}

function countOccurrences(text: string, sub: string): { count: number; firstIndex: number } {
  if (sub.length === 0) return { count: 0, firstIndex: -1 };
  let count = 0;
  let firstIndex = -1;
  let pos = 0;
  while ((pos = text.indexOf(sub, pos)) !== -1) {
    if (firstIndex === -1) firstIndex = pos;
    count += 1;
    pos += sub.length;
  }
  return { count, firstIndex };
}

/** Retorna os numeros de linha (base 1) das primeiras ocorrencias de sub em text. */
function findOccurrenceLines(text: string, sub: string, maxLocations = 10): number[] {
  if (sub.length === 0) return [];
  const lines: number[] = [];
  let pos = 0;
  let lastScanned = 0;
  let currentLine = 1;
  while (lines.length < maxLocations && (pos = text.indexOf(sub, pos)) !== -1) {
    let nl = lastScanned - 1;
    while ((nl = text.indexOf("\n", nl + 1)) !== -1 && nl < pos) {
      currentLine += 1;
    }
    lastScanned = pos;
    lines.push(currentLine);
    pos += sub.length;
  }
  return lines;
}

/** Quando old_string nao e encontrado exatamente, procura uma linha parecida para orientar a correcao. */
function buildMissingOldStringHint(content: string, oldStr: string): string {
  const oldLines = oldStr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 4);
  if (oldLines.length === 0) return "";
  // Escolhe a primeira linha relevante ou a mais longa entre as 3 primeiras para evitar ancoras triviais como "}".
  const candidate = oldLines.slice(0, 3).sort((a, b) => b.length - a.length)[0];
  if (!candidate || candidate.length < 4) return "";

  const fileLines = content.split("\n");
  const candidateLower = candidate.toLowerCase();
  let matchIdx = fileLines.findIndex((line) => line.includes(candidate));
  if (matchIdx === -1) {
    matchIdx = fileLines.findIndex((line) => line.toLowerCase().includes(candidateLower));
  }
  // Fallback 1: prefixo inicial da linha (util quando old_string e uma unica linha longa com divergencia no meio/fim).
  if (matchIdx === -1 && candidateLower.length >= 12) {
    const prefixLen = Math.min(32, Math.max(10, Math.floor(candidateLower.length * 0.4)));
    const prefix = candidateLower.slice(0, prefixLen);
    matchIdx = fileLines.findIndex((line) => line.toLowerCase().includes(prefix));
  }
  // Fallback 2: linha com maior sobreposicao de palavras/tokens significativos (>= 4 chars).
  if (matchIdx === -1) {
    const tokens = Array.from(new Set(oldStr.toLowerCase().match(/[a-z0-9_\u00C0-\u017F]{4,}/g) ?? [])).slice(0, 24);
    if (tokens.length >= 2) {
      const minRequired = Math.max(2, Math.ceil(tokens.length * 0.35));
      let bestScore = 0;
      let bestLine = -1;
      for (let i = 0; i < fileLines.length; i++) {
        const lower = fileLines[i].toLowerCase();
        if (lower.length < 4) continue;
        let score = 0;
        for (const tk of tokens) {
          if (lower.includes(tk)) score += 1;
        }
        if (score >= minRequired && score > bestScore) {
          bestScore = score;
          bestLine = i;
        }
      }
      matchIdx = bestLine;
    }
  }
  if (matchIdx === -1) return "";

  const start = Math.max(0, matchIdx - 2);
  const end = Math.min(fileLines.length, matchIdx + Math.min(oldStr.split("\n").length + 2, 7));
  const snippet = fileLines
    .slice(start, end)
    .map((line, i) => `  ${start + i + 1} | ${line.slice(0, 500)}`)
    .join("\n");
  return `\nTrecho similar encontrado proximo a linha ${matchIdx + 1}:\n${snippet}`;
}

/** Divide um padrao de busca de arquivos por '|' (quando fora de chaves {}), permitindo alternancia estilo regex/glob. */
function splitPatternAlternation(rawPattern: string): string[] {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;
  for (const ch of rawPattern) {
    if (ch === "{") braceDepth += 1;
    else if (ch === "}" && braceDepth > 0) braceDepth -= 1;
    if (ch === "|" && braceDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function normalizeFindGlob(term: string): string {
  return term.includes("/") && !term.startsWith("*") && !term.startsWith("/") && !term.startsWith("!")
    ? `**/${term}`
    : term;
}

function matchesFindTerm(relPath: string, term: string, caseSensitive: boolean): boolean {
  if (!/[*?[\]{}]/.test(term)) {
    return caseSensitive ? relPath.includes(term) : relPath.toLowerCase().includes(term.toLowerCase());
  }
  const regexStr =
    "^" +
    term
      .replace(/[.+^$()|\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  const re = new RegExp(regexStr, caseSensitive ? "" : "i");
  return re.test(relPath) || re.test(path.basename(relPath));
}

/** Valida que o caminho existe e, em caso de ENOENT, informa o diretorio pai existente mais proximo e suas entradas. */
async function assertTargetExistsWithHint(target: string, toolName: string) {
  try {
    return await fs.stat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      let parent = path.dirname(target);
      while (parent !== path.dirname(parent)) {
        try {
          const pStat = await fs.stat(parent);
          if (pStat.isDirectory()) {
            const entries = (await fs.readdir(parent, { withFileTypes: true }))
              .filter((e) => !DEFAULT_SEARCH_IGNORE_DIRS.includes(e.name))
              .sort((a, b) => entryCollator.compare(a.name, b.name))
              .slice(0, 15)
              .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
            const hint = entries.length > 0 ? ` Entradas disponiveis em ${parent}: ${entries.join(", ")}.` : "";
            throw new Error(
              `Caminho inexistente em ${toolName}: ${target}. Diretorio pai existente mais proximo: ${parent}.${hint}`,
            );
          }
        } catch (parentErr) {
          if (parentErr instanceof Error && parentErr.message.startsWith(`Caminho inexistente em ${toolName}:`)) {
            throw parentErr;
          }
        }
        parent = path.dirname(parent);
      }
      throw new Error(`Caminho inexistente em ${toolName}: ${target}.`);
    }
    throw err;
  }
}

/** Constroi lista de flags --glob de exclusao de diretorios pesados para ripgrep. */
function buildSearchIgnoreGlobs(target: string, userGlobs: string[]): string[] {
  const targetSegments = target.split(path.sep);
  const args: string[] = [];
  for (const ignoreDir of DEFAULT_SEARCH_IGNORE_DIRS) {
    const targetInsideDir = targetSegments.includes(ignoreDir);
    const explicitlyReferenced = userGlobs.some((g) => g.includes(ignoreDir));
    if (!targetInsideDir && !explicitlyReferenced) {
      args.push(`--glob=!**/${ignoreDir}/**`);
    }
  }
  // Evita varrer /root/repos/work (centenas de worktrees/logs) quando a busca parte de /root/repos ou home.
  if (
    (target === "/root/repos" || target === os.homedir()) &&
    !targetSegments.includes("work") &&
    !userGlobs.some((g) => g.includes("work"))
  ) {
    args.push("--glob=!**/work/**");
  }
  return args;
}

interface FileSliceParams {
  path: string;
  offset?: number;
  limit?: number;
  char_offset?: number;
  char_limit?: number;
}

async function readSingleFileFormatted(params: FileSliceParams): Promise<string> {
  const target = resolvePath(params.path);
  const hasLineMode = params.offset !== undefined || params.limit !== undefined;
  const hasCharMode = params.char_offset !== undefined || params.char_limit !== undefined;
  if (hasLineMode && hasCharMode) {
    throw new Error("Use paginacao por linhas (offset/limit) OU por caracteres (char_offset/char_limit), nao ambas na mesma chamada.");
  }

  const stat = await fs.stat(target);
  if (!stat.isFile()) {
    throw new Error(`O caminho nao e um arquivo regular: ${target}`);
  }
  const totalBytes = stat.size;
  const maxTextBytes = configuredPositiveNumber("MCP_MAX_TEXT_FILE_BYTES", DEFAULT_MAX_TEXT_FILE_BYTES);

  let content = "";
  if (totalBytes > 0) {
    const sniffLen = Math.min(totalBytes, BINARY_SNIFF_BYTES);
    const handle = await fs.open(target, "r");
    let sniffBuf: Buffer;
    let bytesRead = 0;
    try {
      sniffBuf = Buffer.allocUnsafe(sniffLen);
      const res = await handle.read(sniffBuf, 0, sniffLen, 0);
      bytesRead = res.bytesRead;
    } finally {
      await handle.close();
    }
    const sample = sniffBuf.subarray(0, bytesRead);
    if (sample.includes(0)) {
      throw new Error(
        `Arquivo binario detectado (${target}, ${totalBytes} bytes). Use read_image para imagens (PNG/JPEG/GIF/WebP) ou ferramentas especificas para binarios.`,
      );
    }
    if (totalBytes > maxTextBytes) {
      throw new Error(
        `Arquivo de texto muito grande (${totalBytes} bytes; limite MCP_MAX_TEXT_FILE_BYTES=${maxTextBytes}). Use search_code com path='${target}' para filtrar linhas relevantes.`,
      );
    }
    content = totalBytes <= bytesRead ? sample.toString("utf8") : await fs.readFile(target, "utf8");
  }

  const totalChars = content.length;

  if (hasLineMode) {
    const lines = content.split("\n");
    const totalLines = lines.length;
    const startLine = Math.max(1, params.offset ?? 1);
    const requestedLimit = params.limit ?? totalLines;
    const start = Math.min(startLine - 1, totalLines);
    const end = Math.min(totalLines, start + requestedLimit);
    const selected = lines.slice(start, end).join("\n");
    const preview = previewText(selected);
    const header = [
      `path: ${target}`,
      `mode: lines`,
      `lines: ${start + 1}-${end} of ${totalLines}`,
      `total_chars: ${totalChars}`,
      `total_bytes: ${totalBytes}`,
      `selected_chars: ${selected.length}`,
      `content_truncated: ${preview.truncated}`,
      `has_more_lines: ${end < totalLines}`,
      `next_line_offset: ${end < totalLines ? end + 1 : "null"}`,
      preview.truncated ? "hint: a faixa selecionada excedeu o limite; use char_offset/char_limit para navegar sem perda." : "",
    ]
      .filter(Boolean)
      .join("\n");
    return `${header}\n\n${preview.text}`;
  }

  const totalLines = countLines(content);
  const charOffset = Math.min(params.char_offset ?? 0, totalChars);
  const charLimit = params.char_limit ?? MAX_PREVIEW_CHARS;
  const end = Math.min(totalChars, charOffset + charLimit);
  const selected = content.slice(charOffset, end);
  const header = [
    `path: ${target}`,
    `mode: chars`,
    `char_offset: ${charOffset}`,
    `returned_chars: ${selected.length}`,
    `total_chars: ${totalChars}`,
    `total_lines: ${totalLines}`,
    `total_bytes: ${totalBytes}`,
    `has_more: ${end < totalChars}`,
    `next_char_offset: ${end < totalChars ? end : "null"}`,
  ].join("\n");
  return `${header}\n\n${selected}`;
}

/** Definicao de uma ferramenta MCP: schema de entrada + resultado MCP multimodal. */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export const tools: ToolDef[] = [
  {
    name: "run_command",
    title: "Executar comando",
    description:
      "Executa um comando de shell curto (<30s) na VM (bash), como git status, git diff, gh pr view ou scripts rapidos. " +
      "IMPORTANTE: (1) Para buscar texto/regex em arquivos, use SEMPRE search_code; para localizar arquivos por nome/glob, use SEMPRE find_files. " +
      "(2) Para ler arquivos, prefira read_file (1 arquivo) ou read_files (2 a 20 arquivos) em vez de cat/head/tail/sed. " +
      "(3) Para comandos demorados (>30s como builds, testes, deploys, npm install, gh run watch, pipelines encadeados com && ou invocacao de subagentes CLI como agy), use SEMPRE start_command + poll_command para evitar timeouts. " +
      `Saidas acima de ${MAX_PREVIEW_CHARS} caracteres sao preservadas como artefato temporario e podem ser lidas integralmente com read_command_output.`,
    schema: {
      command: z.string().describe("Comando de shell completo a executar, ex: 'git status -sb' ou 'gh pr list'."),
      cwd: z
        .string()
        .optional()
        .describe("Diretorio de trabalho para o comando. Padrao: diretorio home do usuario."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe("Timeout em milissegundos (max 600000). Padrao: 120000."),
    },
    handler: async (args) => {
      const command = args.command as string;
      const cwd = args.cwd ? resolvePath(args.cwd as string) : os.homedir();
      const cwdStat = await assertTargetExistsWithHint(cwd, "run_command (cwd)");
      if (!cwdStat.isDirectory()) {
        throw new Error(`O diretorio de trabalho (cwd) informado em run_command nao e um diretorio: ${cwd}`);
      }
      const timeout = (args.timeout_ms as number | undefined) ?? 120_000;
      const execution = await executeCommand(command, cwd, timeout);
      const parts = [
        `exit_code: ${execution.exitCode}${execution.timedOut ? " (timeout; grupo de processos encerrado)" : ""}`,
        execution.maxBufferExceeded
          ? `output_limit_exceeded: true (MCP_COMMAND_MAX_BUFFER_BYTES=${configuredPositiveNumber("MCP_COMMAND_MAX_BUFFER_BYTES", DEFAULT_COMMAND_MAX_BUFFER_BYTES)})`
          : "",
        execution.stdout ? `stdout:\n${execution.stdout}` : "stdout: (vazio)",
        execution.stderr ? `stderr:\n${execution.stderr}` : "",
        execution.errorMessage ? `error_message:\n${execution.errorMessage}` : "",
      ].filter(Boolean);
      return commandResult(parts.join("\n"));
    },
  },

  {
    name: "read_command_output",
    title: "Ler saida completa de comando",
    description:
      "Le uma pagina de uma saida grande preservada por run_command, start_command, poll_command, read_files, search_code ou find_files. Use artifact_id retornado e avance pelo next_offset ate has_more=false.",
    schema: {
      artifact_id: z.string().uuid().describe("ID retornado quando a saida foi maior que o limite de visualizacao."),
      offset: z.number().int().nonnegative().optional().describe("Offset em caracteres. Padrao: 0."),
      limit: z
        .number()
        .int()
        .positive()
        .max(DEFAULT_OUTPUT_PAGE_CHARS)
        .optional()
        .describe(`Quantidade maxima de caracteres. Padrao/maximo: ${DEFAULT_OUTPUT_PAGE_CHARS}.`),
    },
    handler: async (args) => {
      const artifactId = args.artifact_id as string;
      const page = await readTextArtifact(
        artifactId,
        (args.offset as number | undefined) ?? 0,
        (args.limit as number | undefined) ?? DEFAULT_OUTPUT_PAGE_CHARS,
      );
      const header = [
        `artifact_id: ${artifactId}`,
        `offset: ${page.offset}`,
        `returned_chars: ${page.text.length}`,
        `total_chars: ${page.totalChars}`,
        `total_bytes: ${page.totalBytes}`,
        `has_more: ${page.nextOffset !== null}`,
        `next_offset: ${page.nextOffset ?? "null"}`,
      ].join("\n");
      return textResult(`${header}\n\n${page.text}`);
    },
  },

  {
    name: "start_command",
    title: "Iniciar comando em background",
    description:
      "Inicia um comando de shell (bash) em background com job_id e aguarda opcionalmente wait_ms (padrao 2000ms). " +
      "Use SEMPRE para builds, deploys, suites de teste (Playwright, Vitest), gh run watch, pipelines encadeados (lint && build && test) ou invocacao de subagentes CLI (agy) sem travar a chamada HTTP. " +
      "Se retornar status: running, chame poll_command passando o job_id e offset=next_offset para acompanhar apenas a saida nova.",
    schema: {
      command: z.string().describe("Comando de shell completo a executar em background."),
      cwd: z.string().optional().describe("Diretorio de trabalho para o comando. Padrao: diretorio home."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(1_800_000)
        .optional()
        .describe("Timeout total do job em milissegundos (max 1800000 / 30 min). Padrao: 600000 (10 min)."),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .optional()
        .describe("Tempo inicial de espera em ms antes de retornar se o comando ainda estiver rodando. Padrao: 2000."),
    },
    handler: async (args) => {
      const command = args.command as string;
      const cwd = args.cwd ? resolvePath(args.cwd as string) : os.homedir();
      const cwdStat = await assertTargetExistsWithHint(cwd, "start_command (cwd)");
      if (!cwdStat.isDirectory()) {
        throw new Error(`O diretorio de trabalho (cwd) informado em start_command nao e um diretorio: ${cwd}`);
      }
      const timeoutMs = (args.timeout_ms as number | undefined) ?? 600_000;
      const waitMs = (args.wait_ms as number | undefined) ?? 2_000;
      const job = startBackgroundJob(command, cwd, timeoutMs);
      await waitForJob(job, waitMs);
      return formatJobResult(job, 0);
    },
  },

  {
    name: "poll_command",
    title: "Consultar ou encerrar comando em background",
    description:
      "Consulta o status e a saida incremental (stdout/stderr) de um job iniciado por start_command, " +
      "aguardando ate wait_ms pela conclusao, ou encerra todo o grupo de processos se kill=true. " +
      "BOAS PRATICAS: passe sempre offset com o valor de next_offset retornado na chamada anterior para ler apenas novas linhas e evitar repetir logs.",
    schema: {
      job_id: z.string().uuid().describe("ID do job retornado por start_command."),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(60_000)
        .optional()
        .describe("Tempo maximo de espera por conclusao nesta chamada em ms (max 60000). Padrao: 5000."),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Offset em caracteres do stdout. Passe SEMPRE o next_offset retornado no poll anterior para receber apenas saida nova. Padrao: 0."),
      kill: z
        .boolean()
        .optional()
        .describe("Se true, encerra o grupo de processos do job (SIGTERM -> SIGKILL). Padrao: false."),
    },
    handler: async (args) => {
      const jobId = args.job_id as string;
      const job = backgroundJobs.get(jobId);
      if (!job) {
        throw new Error(`Job nao encontrado ou expirado: ${jobId}`);
      }
      const kill = (args.kill as boolean | undefined) ?? false;
      const offset = (args.offset as number | undefined) ?? 0;
      if (kill && job.status === "running") {
        job.terminate(true);
        await waitForJob(job, 2_000);
      } else {
        const waitMs = (args.wait_ms as number | undefined) ?? 5_000;
        await waitForJob(job, waitMs);
      }
      return formatJobResult(job, offset);
    },
  },

  {
    name: "read_file",
    title: "Ler arquivo",
    description:
      "Le um unico arquivo de texto com metadata e paginacao. offset/limit operam por linhas; char_offset/char_limit operam por caracteres e sao uteis para arquivos minificados ou linhas muito longas. " +
      "DICA: se precisar ler 2 ou mais arquivos (ou 2 ou mais faixas offset/limit diferentes do mesmo arquivo), prefira read_files para ler tudo em paralelo em uma unica chamada.",
    schema: {
      path: z.string().describe("Caminho do arquivo a ler (absoluto, relativo ou com ~)."),
      offset: z.number().int().nonnegative().optional().describe("Linha inicial (base 1; 0 tambem equivale ao inicio por compatibilidade)."),
      limit: z.number().int().positive().optional().describe("Quantidade de linhas a partir de offset."),
      char_offset: z.number().int().nonnegative().optional().describe("Offset em caracteres, base 0."),
      char_limit: z
        .number()
        .int()
        .positive()
        .max(MAX_PREVIEW_CHARS)
        .optional()
        .describe(`Quantidade maxima de caracteres, ate ${MAX_PREVIEW_CHARS}.`),
    },
    handler: async (args) => {
      const formatted = await readSingleFileFormatted({
        path: args.path as string,
        offset: args.offset as number | undefined,
        limit: args.limit as number | undefined,
        char_offset: args.char_offset as number | undefined,
        char_limit: args.char_limit as number | undefined,
      });
      return textResult(formatted);
    },
  },

  {
    name: "read_files",
    title: "Ler multiplos arquivos em lote",
    description:
      "Le multiplos arquivos (ate 20 arquivos ou multiplas faixas offset/limit do mesmo arquivo) em paralelo em uma unica chamada. " +
      "Prefira esta ferramenta sempre que precisar inspecionar 2 ou mais arquivos ou 2 ou mais trechos distantes de um mesmo arquivo grande de uma vez, substituindo multiplas chamadas de read_file ou comandos bash com sed/head/tail/cat.",
    schema: {
      files: z
        .array(
          z.object({
            path: z.string().describe("Caminho do arquivo a ler."),
            offset: z.number().int().nonnegative().optional().describe("Linha inicial (base 1)."),
            limit: z.number().int().positive().optional().describe("Quantidade de linhas."),
            char_offset: z.number().int().nonnegative().optional().describe("Offset em caracteres (base 0)."),
            char_limit: z.number().int().positive().max(MAX_PREVIEW_CHARS).optional().describe("Limite de caracteres."),
          }),
        )
        .min(1)
        .max(20)
        .describe("Lista de arquivos (ate 20) e faixas opcionais a ler em paralelo."),
    },
    handler: async (args) => {
      const items = args.files as FileSliceParams[];
      const sections = await Promise.all(
        items.map(async (item, index) => {
          const headerPrefix = `=== [${index + 1}/${items.length}] ${resolvePath(item.path)} ===`;
          try {
            const body = await readSingleFileFormatted(item);
            return `${headerPrefix}\n${body}`;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `${headerPrefix}\nstatus: error\nerror: ${msg}`;
          }
        }),
      );
      return commandResult(sections.join("\n\n"));
    },
  },

  {
    name: "search_code",
    title: "Buscar texto ou regex no codigo",
    description:
      "Busca padroes (regex ou texto literal) dentro de arquivos usando ripgrep (rg) diretamente sem shell bash. " +
      "Ignora por padrao diretorios pesados (node_modules, .git, .next, dist, build, coverage) e trata '0 ocorrencias' como resultado limpo (exit_code: 0). " +
      "DICAS: (1) Passe o path mais especifico possivel (ex.: '/root/repos/meu-app/src' em vez de '/root/repos'). " +
      "(2) Defina fixed_strings=true quando buscar trechos literais com parenteses, chaves ou colchetes (ex.: 'Inter(', 'icons: {'); se o regex tiver erro de sintaxe, o servidor faz fallback automatico para texto literal. " +
      "(3) Se quiser localizar arquivos pelo nome/caminho (e nao pelo conteudo interno), use find_files.",
    schema: {
      pattern: z
        .string()
        .min(1)
        .describe("Expressao regular ou texto literal a buscar. Para simbolos/codigo com (), {}, [] ou $, prefira fixed_strings=true."),
      path: z
        .string()
        .optional()
        .describe("Arquivo ou diretorio onde buscar (prefira o subdiretorio especifico do repositorio/pacote). Padrao: diretorio home."),
      globs: z
        .array(z.string())
        .optional()
        .describe("Filtros glob opcionais (ex.: ['*.ts', '*.tsx', '!**/test/**']). node_modules/.git/.next/dist/build/coverage ja sao ignorados por padrao."),
      fixed_strings: z
        .boolean()
        .optional()
        .describe("Tratar pattern como texto literal exato (-F) em vez de regex. Recomendado ao buscar chamadas de funcao ou trechos com pontuacao. Padrao: false."),
      case_sensitive: z
        .boolean()
        .optional()
        .describe("Se true, diferencia maiusculas/minusculas (-s); se false, ignora (-i). Padrao: smart-case (-S)."),
      hidden: z.boolean().optional().describe("Incluir arquivos ocultos (--hidden, excluindo .git). Padrao: false."),
      context_lines: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe("Numero de linhas de contexto antes e depois de cada match (-C). Padrao: 0."),
      max_results: z
        .number()
        .int()
        .positive()
        .max(2_000)
        .optional()
        .describe("Quantidade maxima de linhas de resultado a retornar. Padrao: 200."),
    },
    handler: async (args) => {
      const pattern = args.pattern as string;
      const target = args.path ? resolvePath(args.path as string) : os.homedir();
      const globs = (args.globs as string[] | undefined) ?? [];
      const fixedStrings = (args.fixed_strings as boolean | undefined) ?? false;
      const caseSensitive = args.case_sensitive as boolean | undefined;
      const hidden = (args.hidden as boolean | undefined) ?? false;
      const contextLines = (args.context_lines as number | undefined) ?? 0;
      const maxResults = (args.max_results as number | undefined) ?? 200;

      await assertTargetExistsWithHint(target, "search_code");

      const ignoreArgs = buildSearchIgnoreGlobs(target, globs);
      const buildRgArgs = (useFixedStrings: boolean): string[] => {
        const rgArgs: string[] = [
          "--line-number",
          "--with-filename",
          "--color=never",
          "--no-heading",
        ];
        if (useFixedStrings) rgArgs.push("--fixed-strings");
        if (caseSensitive === true) rgArgs.push("--case-sensitive");
        else if (caseSensitive === false) rgArgs.push("--ignore-case");
        else rgArgs.push("--smart-case");
        if (hidden) {
          rgArgs.push("--hidden");
        }
        if (contextLines > 0) {
          rgArgs.push(`--context=${contextLines}`);
        }
        rgArgs.push(...ignoreArgs);
        for (const glob of globs) {
          rgArgs.push(`--glob=${glob}`);
        }
        rgArgs.push("-e", pattern, "--", target);
        return rgArgs;
      };

      let execution = await executeRipgrep(buildRgArgs(fixedStrings), os.homedir());
      let usedFallbackFixedStrings = false;

      // Se o agente esqueceu fixed_strings=true ao buscar codigo com parenteses/chaves (ex.: "Inter(", "icons: {"),
      // faz fallback automatico para --fixed-strings em vez de falhar com regex parse error.
      if (!fixedStrings && execution.exitCode === 2 && /regex parse error/i.test(execution.stderr)) {
        execution = await executeRipgrep(buildRgArgs(true), os.homedir());
        usedFallbackFixedStrings = true;
      }

      const modeLabel = usedFallbackFixedStrings
        ? "fixed_strings_fallback (regex invalido tratado como texto literal)"
        : fixedStrings
          ? "fixed_strings"
          : "regex";

      // No ripgrep, exit code 1 sem stderr significa apenas "nenhuma ocorrencia encontrada".
      if (execution.exitCode === 1 && !execution.stderr.trim()) {
        return textResult(
          [
            `exit_code: 0`,
            `path: ${target}`,
            `pattern: ${pattern}`,
            `mode: ${modeLabel}`,
            `matches: 0`,
            `truncated: false`,
            "",
            "(nenhuma ocorrencia encontrada)",
          ].join("\n"),
        );
      }

      if (execution.exitCode !== 0 && execution.exitCode !== 1) {
        const errText = execution.stderr.trim() || execution.errorMessage || `ripgrep falhou com codigo ${execution.exitCode}`;
        throw new Error(`Erro ao executar search_code (rg): ${errText}`);
      }

      const rawLines = execution.stdout.replace(/\r?\n$/, "");
      const lines = rawLines ? rawLines.split("\n") : [];
      const truncated = lines.length > maxResults;
      const selectedLines = truncated ? lines.slice(0, maxResults) : lines;

      const header = [
        `exit_code: 0`,
        `path: ${target}`,
        `pattern: ${pattern}`,
        `mode: ${modeLabel}`,
        `returned_lines: ${selectedLines.length}`,
        `total_lines: ${lines.length}`,
        `truncated: ${truncated}`,
        execution.stderr.trim() ? `warnings: ${execution.stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return commandResult(`${header}\n\n${selectedLines.join("\n")}`);
    },
  },

  {
    name: "find_files",
    title: "Localizar arquivos por nome ou glob",
    description:
      "Localiza caminhos de arquivos rapidamente usando ripgrep (rg --files) sem precisar de find/ls no bash e sem ler o conteudo interno dos arquivos. " +
      "Ignora por padrao diretorios pesados (node_modules, .git, .next, dist, build, coverage). " +
      "Suporta alternancia com '|' em pattern (ex.: pattern='*inbox*|*media*|*webhook*') e controle de profundidade via max_depth. " +
      "Use SEMPRE que quiser descobrir onde estao arquivos por trecho do nome, extensao ou padrao glob (ex.: pattern='sidebar', pattern='*.spec.ts', globs=['**/*.tsx']).",
    schema: {
      pattern: z
        .string()
        .optional()
        .describe(
          "Filtro opcional pelo nome ou caminho do arquivo. Aceita multiplos padroes separados por '|' (OR). Se contiver caracteres glob (*, ?, [, {), e avaliado como glob; caso contrario, filtra caminhos que contenham esta substring (ex.: 'Button', '*.spec.ts|*.test.ts', '*inbox*|*media*').",
        ),
      path: z
        .string()
        .optional()
        .describe("Diretorio (ou arquivo) onde procurar (prefira o diretorio do repositorio, ex.: '/root/repos/meu-app'). Padrao: diretorio home."),
      globs: z
        .array(z.string())
        .optional()
        .describe("Filtros glob adicionais do ripgrep (ex.: ['*.ts', '*.tsx', '!**/test/**'])."),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Profundidade maxima de subdiretorios a percorrer (1 = apenas nivel imediato). Util para buscas rasas em diretorios grandes."),
      case_sensitive: z
        .boolean()
        .optional()
        .describe("Diferenciar maiusculas/minusculas ao filtrar pattern. Padrao: false (case-insensitive)."),
      hidden: z
        .boolean()
        .optional()
        .describe("Incluir arquivos ocultos (dotfiles como .env.example, exceto .git). Padrao: true."),
      max_results: z
        .number()
        .int()
        .positive()
        .max(2_000)
        .optional()
        .describe("Quantidade maxima de arquivos a retornar. Padrao: 200."),
    },
    handler: async (args) => {
      const rawPattern = (args.pattern as string | undefined)?.trim();
      const target = args.path ? resolvePath(args.path as string) : os.homedir();
      const globs = (args.globs as string[] | undefined) ?? [];
      const maxDepth = args.max_depth as number | undefined;
      const caseSensitive = (args.case_sensitive as boolean | undefined) ?? false;
      const hidden = (args.hidden as boolean | undefined) ?? true;
      const maxResults = (args.max_results as number | undefined) ?? 200;

      const stat = await assertTargetExistsWithHint(target, "find_files");
      if (stat.isFile()) {
        return textResult(
          [
            `exit_code: 0`,
            `path: ${target}`,
            `pattern: ${rawPattern || "*"}`,
            `returned_files: 1`,
            `total_files: 1`,
            `truncated: false`,
            "",
            target,
          ].join("\n"),
        );
      }

      const patternTerms = rawPattern ? splitPatternAlternation(rawPattern) : [];
      const allTermsAreGlobs = patternTerms.length > 0 && patternTerms.every((t) => /[*?[\]{}]/.test(t));

      const rgArgs: string[] = ["--files", "--color=never"];
      if (hidden) {
        rgArgs.push("--hidden");
      }
      if (maxDepth !== undefined) {
        rgArgs.push(`--max-depth=${maxDepth}`);
      }
      rgArgs.push(...buildSearchIgnoreGlobs(target, globs));
      for (const glob of globs) {
        rgArgs.push(`--glob=${glob}`);
      }
      if (allTermsAreGlobs) {
        for (const term of patternTerms) {
          const normalizedGlob = normalizeFindGlob(term);
          rgArgs.push(`${caseSensitive ? "--glob" : "--iglob"}=${normalizedGlob}`);
        }
      }
      rgArgs.push("--", target);

      const execution = await executeRipgrep(rgArgs, os.homedir());
      // No rg --files, exit code 1 sem stderr ocorre quando nenhum arquivo casa com os globs.
      if (execution.exitCode !== 0 && !(execution.exitCode === 1 && !execution.stderr.trim())) {
        const errText = execution.stderr.trim() || execution.errorMessage || `ripgrep --files falhou com codigo ${execution.exitCode}`;
        throw new Error(`Erro ao executar find_files (rg --files): ${errText}`);
      }

      const rawLines = execution.stdout.replace(/\r?\n$/, "");
      let files = rawLines ? rawLines.split("\n") : [];

      if (patternTerms.length > 0 && !allTermsAreGlobs) {
        files = files.filter((filePath) => {
          const rel = filePath.startsWith(target + path.sep) ? filePath.slice(target.length + 1) : filePath;
          return patternTerms.some((term) => matchesFindTerm(rel, term, caseSensitive));
        });
      }

      files.sort((a, b) => entryCollator.compare(a, b));
      const truncated = files.length > maxResults;
      const selected = truncated ? files.slice(0, maxResults) : files;

      const header = [
        `exit_code: 0`,
        `path: ${target}`,
        `pattern: ${rawPattern || "*"}`,
        `returned_files: ${selected.length}`,
        `total_files: ${files.length}`,
        `truncated: ${truncated}`,
      ].join("\n");

      const body = selected.length > 0 ? selected.join("\n") : "(nenhum arquivo encontrado)";
      return commandResult(`${header}\n\n${body}`);
    },
  },

  {
    name: "read_image",
    title: "Ler imagem",
    description:
      "Le PNG, JPEG, GIF ou WebP da VM e devolve a imagem como ImageContent nativo do MCP, junto com path, MIME, tamanho, dimensoes quando disponiveis e SHA-256. Ideal para screenshots e analise de UX.",
    schema: {
      path: z.string().describe("Caminho da imagem (absoluto, relativo ou com ~)."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error(`O caminho nao e um arquivo: ${target}`);
      const maxImageBytes = Number(process.env.MCP_MAX_IMAGE_BYTES ?? DEFAULT_MAX_IMAGE_BYTES);
      if (!Number.isFinite(maxImageBytes) || maxImageBytes <= 0) {
        throw new Error("MCP_MAX_IMAGE_BYTES deve ser um numero positivo.");
      }
      if (stat.size > maxImageBytes) {
        throw new Error(
          `Imagem muito grande: ${stat.size} bytes. Limite atual: ${maxImageBytes} bytes (MCP_MAX_IMAGE_BYTES).`,
        );
      }
      const buffer = await fs.readFile(target);
      const info = detectImage(buffer);
      if (!info) throw new Error(`Formato de imagem nao suportado ou arquivo invalido: ${target}`);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const dimensions = info.width && info.height ? `${info.width}x.${info.height}`.replace("x.", "x") : "nao detectadas";
      return {
        content: [
          {
            type: "text",
            text: [
              `path: ${target}`,
              `mime_type: ${info.mimeType}`,
              `bytes: ${buffer.length}`,
              `dimensions: ${dimensions}`,
              `sha256: ${sha256}`,
            ].join("\n"),
          },
          {
            type: "image",
            data: buffer.toString("base64"),
            mimeType: info.mimeType,
          },
        ],
      };
    },
  },

  {
    name: "write_file",
    title: "Escrever arquivo",
    description: "Cria ou sobrescreve um arquivo completo com o conteudo fornecido. Cria os diretorios pais se necessario. Para alteracoes parciais em arquivo existente, prefira edit_file ou multi_edit_file.",
    schema: {
      path: z.string().describe("Caminho do arquivo a escrever."),
      content: z.string().describe("Conteudo completo a gravar no arquivo."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, args.content as string, "utf8");
      return textResult(`Arquivo gravado: ${target} (${(args.content as string).length} caracteres).`);
    },
  },

  {
    name: "edit_file",
    title: "Editar arquivo",
    description:
      "Substitui um trecho de texto exato dentro de um arquivo. old_string deve ser unico no arquivo, a menos que replace_all seja true. " +
      "DICA: se precisar alterar 2 ou mais trechos diferentes do mesmo arquivo, prefira multi_edit_file para aplicar todas as mudancas em uma unica chamada atomica.",
    schema: {
      path: z.string().describe("Caminho do arquivo a editar."),
      old_string: z.string().describe("Texto exato a ser substituido (incluindo indentacao)."),
      new_string: z.string().describe("Texto que substituira old_string."),
      replace_all: z.boolean().optional().describe("Substituir todas as ocorrencias. Padrao: false."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      const oldStr = args.old_string as string;
      const newStr = args.new_string as string;
      const replaceAll = (args.replace_all as boolean | undefined) ?? false;
      const content = await fs.readFile(target, "utf8");
      const { count: occurrences, firstIndex } = countOccurrences(content, oldStr);
      if (occurrences === 0) {
        const hint = buildMissingOldStringHint(content, oldStr);
        throw new Error(`old_string nao encontrado em ${target}.${hint}`);
      }
      if (occurrences > 1 && !replaceAll) {
        const lineNums = findOccurrenceLines(content, oldStr);
        const linesLabel = lineNums.length > 0 ? ` (linhas ${lineNums.join(", ")}${occurrences > lineNums.length ? ", ..." : ""})` : "";
        throw new Error(
          `old_string aparece ${occurrences} vezes em ${target}${linesLabel}. Inclua linhas vizinhas para torna-lo unico ou use replace_all=true.`,
        );
      }
      const updated = replaceAll
        ? content.replaceAll(oldStr, newStr)
        : `${content.slice(0, firstIndex)}${newStr}${content.slice(firstIndex + oldStr.length)}`;
      await fs.writeFile(target, updated, "utf8");
      return textResult(`Arquivo editado: ${target} (${replaceAll ? occurrences : 1} substituicao(oes)).`);
    },
  },

  {
    name: "multi_edit_file",
    title: "Editar multiplos trechos de um arquivo",
    description:
      "Aplica multiplas substituicoes exatas (old_string -> new_string) em sequencia no mesmo arquivo de forma atomica " +
      "(uma unica leitura e gravacao). Se qualquer substituicao falhar, o arquivo nao e modificado. " +
      "Prefira esta ferramenta sempre que precisar fazer 2 ou mais alteracoes no mesmo arquivo.",
    schema: {
      path: z.string().describe("Caminho do arquivo a editar."),
      edits: z
        .array(
          z.object({
            old_string: z.string().min(1).describe("Texto exato a ser substituido (incluindo indentacao)."),
            new_string: z.string().describe("Novo texto literal."),
            replace_all: z.boolean().optional().describe("Substituir todas as ocorrencias deste trecho. Padrao: false."),
          }),
        )
        .min(1)
        .max(50)
        .describe("Lista ordenada de edicoes a aplicar em sequencia no arquivo."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      const edits = args.edits as Array<{ old_string: string; new_string: string; replace_all?: boolean }>;
      let updated = await fs.readFile(target, "utf8");
      let totalReplacements = 0;

      for (let i = 0; i < edits.length; i += 1) {
        const edit = edits[i];
        const replaceAll = edit.replace_all ?? false;
        const { count: occurrences, firstIndex } = countOccurrences(updated, edit.old_string);
        if (occurrences === 0) {
          const hint = buildMissingOldStringHint(updated, edit.old_string);
          throw new Error(`Edicao #${i + 1}: old_string nao encontrado em ${target}. Nenhuma alteracao foi gravada.${hint}`);
        }
        if (occurrences > 1 && !replaceAll) {
          const lineNums = findOccurrenceLines(updated, edit.old_string);
          const linesLabel = lineNums.length > 0 ? ` (linhas ${lineNums.join(", ")}${occurrences > lineNums.length ? ", ..." : ""})` : "";
          throw new Error(
            `Edicao #${i + 1}: old_string aparece ${occurrences} vezes em ${target}${linesLabel}. Inclua linhas vizinhas para torna-lo unico ou use replace_all=true. Nenhuma alteracao foi gravada.`,
          );
        }
        updated = replaceAll
          ? updated.replaceAll(edit.old_string, edit.new_string)
          : `${updated.slice(0, firstIndex)}${edit.new_string}${updated.slice(firstIndex + edit.old_string.length)}`;
        totalReplacements += replaceAll ? occurrences : 1;
      }

      await fs.writeFile(target, updated, "utf8");
      return textResult(
        `Arquivo editado: ${target} (${edits.length} bloco(s) aplicados, ${totalReplacements} substituicao(oes) no total).`,
      );
    },
  },

  {
    name: "list_directory",
    title: "Listar diretorio",
    description:
      "Lista arquivos e subdiretorios com paginacao e profundidade opcional (max_depth de 1 a 4). " +
      "Em max_depth > 1, ignora automaticamente node_modules, .git, .next, dist, build e coverage. " +
      "DICA: para localizar arquivos por nome ou extensao em toda a arvore, prefira find_files.",
    schema: {
      path: z.string().optional().describe("Diretorio a listar. Padrao: diretorio home."),
      offset: z.number().int().nonnegative().optional().describe("Indice inicial, base 0. Padrao: 0."),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_DIRECTORY_LIMIT)
        .optional()
        .describe(`Quantidade maxima de entradas. Padrao: ${DEFAULT_DIRECTORY_LIMIT}; maximo: ${MAX_DIRECTORY_LIMIT}.`),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe("Profundidade maxima de listagem recursiva (1 a 4). Padrao: 1."),
    },
    handler: async (args) => {
      const target = args.path ? resolvePath(args.path as string) : os.homedir();
      const maxDepth = (args.max_depth as number | undefined) ?? 1;
      await assertTargetExistsWithHint(target, "list_directory");

      interface DirItem {
        kind: "dir " | "link" | "file";
        relPath: string;
      }
      const collected: DirItem[] = [];
      const maxCollect = 5_000;

      const walk = async (currentDir: string, prefix: string, depth: number): Promise<void> => {
        if (collected.length >= maxCollect) return;
        const dirents = (await fs.readdir(currentDir, { withFileTypes: true })).sort((a, b) =>
          entryCollator.compare(a.name, b.name),
        );
        for (const e of dirents) {
          if (collected.length >= maxCollect) break;
          if (maxDepth > 1 && e.isDirectory()) {
            if (DEFAULT_SEARCH_IGNORE_DIRS.includes(e.name)) continue;
            if (e.name === "work" && currentDir === "/root/repos") continue;
          }
          const relPath = prefix ? `${prefix}/${e.name}` : e.name;
          const kind: DirItem["kind"] = e.isDirectory() ? "dir " : e.isSymbolicLink() ? "link" : "file";
          collected.push({ kind, relPath });
          if (e.isDirectory() && depth < maxDepth) {
            try {
              await walk(path.join(currentDir, e.name), relPath, depth + 1);
            } catch {
              // Ignora subdiretorios sem permissao durante listagem recursiva.
            }
          }
        }
      };

      await walk(target, "", 1);

      const offset = Math.min((args.offset as number | undefined) ?? 0, collected.length);
      const limit = (args.limit as number | undefined) ?? DEFAULT_DIRECTORY_LIMIT;
      const end = Math.min(collected.length, offset + limit);
      const page = collected.slice(offset, end);
      const lines = page.map((item) => `${item.kind}  ${item.relPath}`);
      const header = [
        `path: ${target}`,
        maxDepth > 1 ? `max_depth: ${maxDepth}` : "",
        `total: ${collected.length}`,
        `offset: ${offset}`,
        `returned: ${page.length}`,
        `has_more: ${end < collected.length}`,
        `next_offset: ${end < collected.length ? end : "null"}`,
      ]
        .filter(Boolean)
        .join("\n");
      return textResult(`${header}${lines.length ? `\n\n${lines.join("\n")}` : "\n\n(diretorio vazio ou pagina sem entradas)"}`);
    },
  },

  {
    name: "move_file",
    title: "Mover/renomear",
    description: "Move ou renomeia um arquivo ou diretorio. Cria o diretorio de destino se necessario.",
    schema: {
      source: z.string().describe("Caminho de origem."),
      destination: z.string().describe("Caminho de destino."),
    },
    handler: async (args) => {
      const src = resolvePath(args.source as string);
      const dest = resolvePath(args.destination as string);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      return textResult(`Movido: ${src} -> ${dest}.`);
    },
  },

  {
    name: "make_directory",
    title: "Criar diretorio",
    description: "Cria um diretorio, incluindo diretorios pais (mkdir -p).",
    schema: {
      path: z.string().describe("Caminho do diretorio a criar."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      await fs.mkdir(target, { recursive: true });
      return textResult(`Diretorio criado: ${target}.`);
    },
  },

  {
    name: "delete_path",
    title: "Excluir arquivo/diretorio",
    description: "Exclui um arquivo ou diretorio. Para diretorios, use recursive=true. Operacao irreversivel.",
    schema: {
      path: z.string().describe("Caminho a excluir."),
      recursive: z.boolean().optional().describe("Excluir diretorio e todo o conteudo. Padrao: false."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      const recursive = (args.recursive as boolean | undefined) ?? false;
      await fs.rm(target, { recursive, force: false });
      return textResult(`Excluido: ${target}.`);
    },
  },
];
