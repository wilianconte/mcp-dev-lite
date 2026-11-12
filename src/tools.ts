import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, promises as fs } from "node:fs";
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
const MAX_STORED_JOBS = 500;
const JOB_RETENTION_MS = 12 * 60 * 60 * 1000;
const EXIT_PIPE_DRAIN_GRACE_MS = 250;
const JOBS_STORE_DIR = path.join(os.tmpdir(), "mcp-dev-agent-jobs");
const DEFAULT_SEARCH_IGNORE_DIRS = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".turbo",
  ".cache",
  "playwright-report",
  "test-results",
  ".nvm",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".local",
  ".cargo",
  ".rustup",
  ".codex",
  ".gemini",
  ".vscode-server",
  ".cursor-server",
];

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

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

const commandEnvCache = new Map<string, { expiresAt: number; pathValue: string }>();
const COMMAND_ENV_CACHE_TTL_MS = 60_000;
const numericVersionCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function extractNodeVersionFromPackageJson(pkgPath: string, currentMajor: number): string {
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as {
      volta?: { node?: unknown };
      engines?: { node?: unknown };
    };
    if (typeof pkg?.volta?.node === "string" && pkg.volta.node.trim()) {
      return pkg.volta.node.trim().replace(/^v/i, "");
    }
    const engineSpec = typeof pkg?.engines?.node === "string" ? pkg.engines.node.trim() : "";
    if (!engineSpec) return "";
    // Se for apenas um piso ">=X" e o Node atual do processo ja atende X, mantem o Node atual.
    const floorMatch = engineSpec.match(/^>=\s*v?(\d+)(?:\.\d+){0,2}$/i);
    if (floorMatch) {
      const reqMajor = Number(floorMatch[1]);
      if (Number.isFinite(reqMajor) && reqMajor > currentMajor) {
        return String(reqMajor);
      }
      return "";
    }
    const versionMatches = Array.from(engineSpec.matchAll(/v?(\d+(?:\.\d+){0,2})/gi)).map((m) => m[1]);
    if (versionMatches.length === 0) return "";
    const chosen = versionMatches.sort((a, b) => numericVersionCollator.compare(a, b))[versionMatches.length - 1];
    const major = Number(chosen.split(".")[0]);
    if (engineSpec.includes(">=") && Number.isFinite(major) && major <= currentMajor) {
      return "";
    }
    return chosen;
  } catch {
    return "";
  }
}

function resolveNvmNodeBin(cwd: string): string | undefined {
  const nvmVersionsDir = path.join(os.homedir(), ".nvm", "versions", "node");
  if (!existsSync(nvmVersionsDir)) return undefined;
  const currentMajor = Number(process.versions.node.split(".")[0]) || 22;
  let dir = cwd;
  let requested = "";
  let fallbackEngineRequested = "";
  for (let depth = 0; depth < 8; depth += 1) {
    for (const rcFile of [".nvmrc", ".node-version"]) {
      const rcPath = path.join(dir, rcFile);
      if (existsSync(rcPath)) {
        try {
          requested = readFileSync(rcPath, "utf8").split(/\r?\n/)[0].trim().replace(/^v/i, "");
        } catch {
          requested = "";
        }
        if (requested) break;
      }
    }
    if (requested) break;
    if (!fallbackEngineRequested) {
      const pkgPath = path.join(dir, "package.json");
      if (existsSync(pkgPath)) {
        fallbackEngineRequested = extractNodeVersionFromPackageJson(pkgPath, currentMajor);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const targetVersion = requested || fallbackEngineRequested;
  if (!targetVersion) return undefined;
  try {
    const installed = readdirSync(nvmVersionsDir).sort((a, b) => numericVersionCollator.compare(a, b));
    const prefix = `v${targetVersion}`;
    const exactOrPrefix = installed.filter((name) => name === prefix || name.startsWith(`${prefix}.`));
    let chosen = exactOrPrefix[exactOrPrefix.length - 1];
    if (!chosen && !requested && fallbackEngineRequested) {
      const reqMajor = Number(fallbackEngineRequested.split(".")[0]);
      if (Number.isFinite(reqMajor)) {
        const geCandidates = installed.filter((name) => {
          const m = Number(name.replace(/^v/i, "").split(".")[0]);
          return Number.isFinite(m) && m >= reqMajor;
        });
        chosen = geCandidates[geCandidates.length - 1];
      }
    }
    if (!chosen) return undefined;
    const binDir = path.join(nvmVersionsDir, chosen, "bin");
    return existsSync(binDir) ? binDir : undefined;
  } catch {
    return undefined;
  }
}

function buildCommandEnv(cwd: string): NodeJS.ProcessEnv {
  const now = Date.now();
  const basePath = process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  const cacheKey = `${cwd}::${basePath}`;
  const cached = commandEnvCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { ...process.env, PATH: cached.pathValue };
  }

  const prependDirs: string[] = [];
  const nvmBin = resolveNvmNodeBin(cwd);
  if (nvmBin) {
    prependDirs.push(nvmBin);
  }
  const localBin = path.join(os.homedir(), ".local", "bin");
  if (existsSync(localBin)) {
    prependDirs.push(localBin);
  }

  const parts = [...prependDirs, ...basePath.split(path.delimiter).filter(Boolean)];
  const deduped = Array.from(new Set(parts)).join(path.delimiter);
  commandEnvCache.set(cacheKey, { expiresAt: now + COMMAND_ENV_CACHE_TTL_MS, pathValue: deduped });
  return { ...process.env, PATH: deduped };
}

function executeCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandExecution> {
  return new Promise((resolve) => {
    let timedOut = false;
    let maxBufferExceeded = false;
    let spawnError: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let exitDrainTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const maxBuffer = configuredPositiveNumber("MCP_COMMAND_MAX_BUFFER_BYTES", DEFAULT_COMMAND_MAX_BUFFER_BYTES);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;

    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env: buildCommandEnv(cwd),
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
      if (maxBufferExceeded || settled) return;
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

    const finalize = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      if (timedOut || maxBufferExceeded) killProcessGroup(child.pid, "SIGKILL");
      try {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      } catch {
        // Ignora erro ao destruir pipes ja fechados.
      }
      const errorMessage = spawnError ?? (signal && !timedOut && !maxBufferExceeded ? `Processo encerrado por sinal ${signal}.` : undefined);
      resolve({
        exitCode: timedOut ? "timeout" : maxBufferExceeded ? "output_limit" : code ?? "desconhecido",
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        maxBufferExceeded,
        errorMessage,
      });
    };

    child.on("exit", (code, signal) => {
      if (!settled && !exitDrainTimer) {
        exitDrainTimer = setTimeout(() => finalize(code, signal), EXIT_PIPE_DRAIN_GRACE_MS);
        exitDrainTimer.unref();
      }
    });

    child.on("close", (code, signal) => finalize(code, signal));
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
  stderrOffsetByStdoutOffset: Map<number, number>;
  lastReturnedStderrOffset?: number;
  capturedBytes: number;
  timedOut: boolean;
  maxBufferExceeded: boolean;
  killedByUser: boolean;
  recoveredFromDisk?: boolean;
  streamJsonResultNotified?: boolean;
  errorMessage?: string;
  waiters: Set<() => void>;
  terminate: (byUser?: boolean) => void;
}

interface PersistedJobSnapshot {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  startedAtMs: number;
  finishedAtMs?: number;
  status: "running" | "completed" | "timed_out" | "output_limit" | "killed";
  exitCode: number | string | null;
  stdout: string;
  stderr: string;
  stderrOffsets?: Array<[number, number]>;
  lastReturnedStderrOffset?: number;
  capturedBytes: number;
  timedOut: boolean;
  maxBufferExceeded: boolean;
  killedByUser: boolean;
  errorMessage?: string;
}

const backgroundJobs = new Map<string, BackgroundJob>();

function jobSnapshotPath(id: string): string {
  return path.join(JOBS_STORE_DIR, `${id}.json`);
}

async function persistJobSnapshot(job: BackgroundJob): Promise<void> {
  try {
    await fs.mkdir(JOBS_STORE_DIR, { recursive: true });
    const snapshot: PersistedJobSnapshot = {
      id: job.id,
      command: job.command,
      cwd: job.cwd,
      pid: job.pid,
      startedAtMs: job.startedAtMs,
      finishedAtMs: job.finishedAtMs,
      status: job.status,
      exitCode: job.exitCode,
      stdout: Buffer.concat(job.stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(job.stderrChunks).toString("utf8"),
      stderrOffsets: Array.from(job.stderrOffsetByStdoutOffset.entries()),
      lastReturnedStderrOffset: job.lastReturnedStderrOffset,
      capturedBytes: job.capturedBytes,
      timedOut: job.timedOut,
      maxBufferExceeded: job.maxBufferExceeded,
      killedByUser: job.killedByUser,
      errorMessage: job.errorMessage,
    };
    const filePath = jobSnapshotPath(job.id);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(snapshot), "utf8");
    await fs.rename(tmpPath, filePath);
  } catch {
    // Falha de persistencia em disco nao deve interromper a execucao do job.
  }
}

async function loadPersistedJob(id: string): Promise<BackgroundJob | undefined> {
  try {
    const raw = await fs.readFile(jobSnapshotPath(id), "utf8");
    const snap = JSON.parse(raw) as PersistedJobSnapshot;
    let killTimer: NodeJS.Timeout | undefined;
    const job: BackgroundJob = {
      id: snap.id,
      command: snap.command,
      cwd: snap.cwd,
      pid: snap.pid,
      startedAtMs: snap.startedAtMs,
      finishedAtMs: snap.finishedAtMs,
      status: snap.status,
      exitCode: snap.exitCode,
      stdoutChunks: snap.stdout ? [Buffer.from(snap.stdout, "utf8")] : [],
      stderrChunks: snap.stderr ? [Buffer.from(snap.stderr, "utf8")] : [],
      stderrOffsetByStdoutOffset: new Map(snap.stderrOffsets ?? [[0, 0]]),
      lastReturnedStderrOffset: snap.lastReturnedStderrOffset ?? 0,
      capturedBytes: snap.capturedBytes ?? 0,
      timedOut: Boolean(snap.timedOut),
      maxBufferExceeded: Boolean(snap.maxBufferExceeded),
      killedByUser: Boolean(snap.killedByUser),
      recoveredFromDisk: true,
      errorMessage: snap.errorMessage,
      waiters: new Set(),
      terminate: (byUser = false) => {
        if (job.status !== "running") return;
        if (byUser) job.killedByUser = true;
        killProcessGroup(job.pid, "SIGTERM");
        if (!killTimer) {
          killTimer = setTimeout(() => killProcessGroup(job.pid, "SIGKILL"), 1_000);
          killTimer.unref();
        }
        job.finishedAtMs = Date.now();
        job.status = byUser ? "killed" : "completed";
        job.exitCode = byUser ? "killed" : (job.exitCode ?? "terminated");
        void persistJobSnapshot(job);
        for (const notify of job.waiters) notify();
        job.waiters.clear();
      },
    };
    if (job.status === "running" && !isProcessAlive(job.pid)) {
      job.status = "completed";
      job.exitCode = job.exitCode ?? "0 (recovered_after_restart)";
      job.finishedAtMs = job.finishedAtMs ?? Date.now();
      await persistJobSnapshot(job);
    }
    backgroundJobs.set(job.id, job);
    return job;
  } catch {
    return undefined;
  }
}

function pruneBackgroundJobs(): void {
  const now = Date.now();
  for (const [id, job] of backgroundJobs.entries()) {
    if (job.status !== "running" && job.finishedAtMs && now - job.finishedAtMs > JOB_RETENTION_MS) {
      backgroundJobs.delete(id);
      void fs.unlink(jobSnapshotPath(id)).catch(() => undefined);
    }
  }
  if (backgroundJobs.size > MAX_STORED_JOBS) {
    const finished = Array.from(backgroundJobs.values())
      .filter((j) => j.status !== "running")
      .sort((a, b) => (a.finishedAtMs ?? 0) - (b.finishedAtMs ?? 0));
    while (backgroundJobs.size > MAX_STORED_JOBS && finished.length > 0) {
      const oldest = finished.shift()!;
      backgroundJobs.delete(oldest.id);
      void fs.unlink(jobSnapshotPath(oldest.id)).catch(() => undefined);
    }
  }
  void fs
    .readdir(JOBS_STORE_DIR)
    .then(async (entries) => {
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const jobId = entry.slice(0, -5);
        const inMemory = backgroundJobs.get(jobId);
        if (inMemory && (inMemory.status === "running" || isProcessAlive(inMemory.pid))) {
          continue;
        }
        const fullPath = path.join(JOBS_STORE_DIR, entry);
        try {
          const stat = await fs.stat(fullPath);
          if (now - stat.mtimeMs > JOB_RETENTION_MS) {
            const raw = await fs.readFile(fullPath, "utf8").catch(() => "");
            if (raw) {
              try {
                const snap = JSON.parse(raw) as PersistedJobSnapshot;
                if (snap.status === "running" && isProcessAlive(snap.pid)) {
                  continue;
                }
              } catch {
                // Continua para remocao se o JSON estiver corrompido.
              }
            }
            await fs.unlink(fullPath);
          }
        } catch {
          // Ignora arquivos ja removidos.
        }
      }
    })
    .catch(() => undefined);
}

function startBackgroundJob(command: string, cwd: string, timeoutMs: number): BackgroundJob {
  pruneBackgroundJobs();
  const id = randomUUID();
  const maxBuffer = configuredPositiveNumber("MCP_COMMAND_MAX_BUFFER_BYTES", DEFAULT_COMMAND_MAX_BUFFER_BYTES);
  let killTimer: NodeJS.Timeout | undefined;
  let exitDrainTimer: NodeJS.Timeout | undefined;
  let finalized = false;

  const child = spawn("/bin/bash", ["-c", command], {
    cwd,
    env: buildCommandEnv(cwd),
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
    stderrOffsetByStdoutOffset: new Map([[0, 0]]),
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
    if (job.maxBufferExceeded || finalized) return;
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

  const finalizeJob = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    if (exitDrainTimer) clearTimeout(exitDrainTimer);
    if (job.timedOut || job.maxBufferExceeded || job.killedByUser) {
      killProcessGroup(child.pid, "SIGKILL");
    }
    try {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    } catch {
      // Ignora erro ao destruir pipes ja fechados.
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
    void persistJobSnapshot(job);
    for (const notify of job.waiters) notify();
    job.waiters.clear();
  };

  child.on("exit", (code, signal) => {
    if (!finalized && !exitDrainTimer) {
      exitDrainTimer = setTimeout(() => finalizeJob(code, signal), EXIT_PIPE_DRAIN_GRACE_MS);
      exitDrainTimer.unref();
    }
  });

  child.on("close", (code, signal) => finalizeJob(code, signal));

  backgroundJobs.set(id, job);
  void persistJobSnapshot(job);
  return job;
}

interface RedirectedFileInfo {
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
  tailPreview: string;
  hasStreamJsonResult: boolean;
}

function extractRedirectedFiles(command: string, cwd: string): string[] {
  const regex = /(?:^|[\s;|&()])(?:[12]?>>?|[&]>>?)\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&><()'"]+))/g;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(command)) !== null) {
    const rawTarget = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!rawTarget || rawTarget.startsWith("&") || rawTarget === "/dev/null" || /[$`*?[\]{}]/.test(rawTarget)) {
      continue;
    }
    const resolved = rawTarget.startsWith("~/")
      ? path.join(os.homedir(), rawTarget.slice(2))
      : path.isAbsolute(rawTarget)
        ? path.normalize(rawTarget)
        : path.resolve(cwd, rawTarget);
    seen.add(resolved);
    if (seen.size >= 4) break;
  }
  return Array.from(seen);
}

async function inspectRedirectedFiles(job: BackgroundJob): Promise<RedirectedFileInfo[]> {
  const targets = extractRedirectedFiles(job.command, job.cwd);
  if (targets.length === 0) return [];
  const results: RedirectedFileInfo[] = [];
  for (const filePath of targets) {
    try {
      const st = await fs.stat(filePath);
      if (!st.isFile()) continue;
      if (st.mtimeMs < job.startedAtMs - 2_000 && st.ctimeMs < job.startedAtMs - 2_000) continue;
      let tailText = "";
      if (st.size > 0) {
        const readLen = Math.min(st.size, 8_192);
        const readPos = Math.max(0, st.size - readLen);
        const handle = await fs.open(filePath, "r");
        try {
          const buf = Buffer.allocUnsafe(readLen);
          const { bytesRead } = await handle.read(buf, 0, readLen, readPos);
          const slice = buf.subarray(0, bytesRead);
          if (!slice.includes(0)) {
            tailText = slice.toString("utf8");
          }
        } finally {
          await handle.close();
        }
      }
      const hasStreamJsonResult = /"event"\s*:\s*"result"/.test(tailText);
      let tailPreview = tailText.trim();
      if (tailPreview.length > 1_200) {
        tailPreview = `...(truncado)...\n${tailPreview.slice(-1_200)}`;
      }
      results.push({
        filePath,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        tailPreview,
        hasStreamJsonResult,
      });
    } catch {
      // Ignora arquivos ainda nao criados ou inacessiveis.
    }
  }
  return results;
}

function waitForJob(job: BackgroundJob, waitMs: number): Promise<void> {
  if (job.status !== "running" || waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let livenessInterval: NodeJS.Timeout | undefined;
    let streamCheckInterval: NodeJS.Timeout | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (livenessInterval) clearInterval(livenessInterval);
      if (streamCheckInterval) clearInterval(streamCheckInterval);
      job.waiters.delete(onDone);
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, waitMs);
    timer.unref();
    if (job.recoveredFromDisk) {
      livenessInterval = setInterval(() => {
        if (!isProcessAlive(job.pid)) {
          job.status = "completed";
          job.exitCode = job.exitCode ?? "0 (recovered_after_restart)";
          job.finishedAtMs = job.finishedAtMs ?? Date.now();
          void persistJobSnapshot(job);
          onDone();
        }
      }, 500);
      livenessInterval.unref();
    }
    const hasRedirections = extractRedirectedFiles(job.command, job.cwd).length > 0;
    if (!job.streamJsonResultNotified && waitMs >= 1_500 && (hasRedirections || job.command.includes("stream-json"))) {
      streamCheckInterval = setInterval(() => {
        if (job.status !== "running" || job.streamJsonResultNotified) return;
        void inspectRedirectedFiles(job)
          .then((infos) => {
            if (job.status !== "running" || job.streamJsonResultNotified) return;
            const ready = infos.some((info) => info.hasStreamJsonResult && Date.now() - info.mtimeMs >= 1_500);
            if (ready) {
              job.streamJsonResultNotified = true;
              onDone();
            }
          })
          .catch(() => undefined);
      }, 750);
      streamCheckInterval.unref();
    }
    job.waiters.add(onDone);
  });
}

function compactRepeatedWatchFrames(text: string): { text: string; compactedFrames: number } {
  const markerRegex = /Refreshing (?:run|checks) status every \d+ seconds\. Press Ctrl\+C to quit\./g;
  const matches = Array.from(text.matchAll(markerRegex));
  if (matches.length <= 1) {
    return { text, compactedFrames: 0 };
  }
  const firstIndex = matches[0].index ?? 0;
  const lastIndex = matches[matches.length - 1].index ?? 0;
  const prefix = text.slice(0, firstIndex).trimEnd();
  const latestFrame = text.slice(lastIndex);
  const compactedFrames = matches.length - 1;
  const summaryLine = `[... ${compactedFrames} frames intermediarios repetidos de 'gh watch' omitidos; exibindo apenas o snapshot mais recente ...]`;
  const combined = prefix
    ? `${prefix}\n\n${summaryLine}\n${latestFrame}`
    : `${summaryLine}\n${latestFrame}`;
  return { text: combined, compactedFrames };
}

function resolveStderrOffsetForStdoutOffset(job: BackgroundJob, safeStdoutOffset: number): number {
  if (safeStdoutOffset < 0) return 0;
  const exact = job.stderrOffsetByStdoutOffset.get(safeStdoutOffset);
  if (exact !== undefined) return exact;
  let bestStdout = 0;
  let bestStderr = 0;
  for (const [outOff, errOff] of job.stderrOffsetByStdoutOffset.entries()) {
    if (outOff <= safeStdoutOffset && outOff >= bestStdout) {
      bestStdout = outOff;
      bestStderr = errOff;
    }
  }
  return bestStderr;
}

function uuidHammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 999;
  let dist = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) dist += 1;
  }
  return dist;
}

async function resolveJobWithTypoTolerance(
  requestedId: string | undefined,
  allowSingleRunningFallback = false,
): Promise<{ job?: BackgroundJob; autoCorrectedFrom?: string; activeJobsHint: string }> {
  const cleanId = requestedId?.trim() ?? "";
  if (cleanId) {
    const exact = backgroundJobs.get(cleanId) ?? (await loadPersistedJob(cleanId));
    if (exact) {
      return { job: exact, activeJobsHint: "" };
    }
  }
  const normReq = cleanId.toLowerCase();
  try {
    const entries = await fs.readdir(JOBS_STORE_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const diskId = entry.slice(0, -5);
      if (!backgroundJobs.has(diskId)) {
        await loadPersistedJob(diskId);
      }
    }
  } catch {
    // Ignora se diretorio ainda nao existir.
  }

  if (normReq) {
    let bestJob: BackgroundJob | undefined;
    let bestDist = 999;
    let ties = 0;
    for (const candidate of backgroundJobs.values()) {
      const dist = uuidHammingDistance(normReq, candidate.id.toLowerCase());
      if (dist < bestDist) {
        bestDist = dist;
        bestJob = candidate;
        ties = 1;
      } else if (dist === bestDist) {
        ties += 1;
      }
    }

    if (bestJob && bestDist <= 2 && ties === 1) {
      return { job: bestJob, autoCorrectedFrom: cleanId, activeJobsHint: "" };
    }
  }

  // Fallback v1.4.8: em operacoes somente-leitura (kill=false), se o job_id foi omitido ou alucinado pelo agente
  // e existe exatamente 1 job em execucao ativa (running), resolve automaticamente para esse job.
  if (allowSingleRunningFallback) {
    const runningJobs = Array.from(backgroundJobs.values()).filter(
      (j) => j.status === "running" && isProcessAlive(j.pid),
    );
    if (runningJobs.length === 1) {
      return {
        job: runningJobs[0],
        autoCorrectedFrom: cleanId || undefined,
        activeJobsHint: "",
      };
    }
  }

  const recentJobs = Array.from(backgroundJobs.values())
    .sort((a, b) => {
      const aRun = a.status === "running" ? 1 : 0;
      const bRun = b.status === "running" ? 1 : 0;
      if (bRun !== aRun) return bRun - aRun;
      return b.startedAtMs - a.startedAtMs;
    })
    .slice(0, 5);

  const activeJobsHint =
    recentJobs.length > 0
      ? ` Jobs recentes disponiveis: ${recentJobs
          .map((j) => `${j.id} (status=${j.status}, cmd="${j.command.replace(/\s+/g, " ").slice(0, 60)}")`)
          .join("; ")}.`
      : "";

  return { job: undefined, activeJobsHint };
}

async function formatJobResult(
  job: BackgroundJob,
  stdoutOffset = 0,
  explicitStderrOffset?: number,
  autoCorrectedFrom?: string,
): Promise<CallToolResult> {
  const fullStdout = Buffer.concat(job.stdoutChunks).toString("utf8");
  const fullStderr = Buffer.concat(job.stderrChunks).toString("utf8");
  const safeOffset = Math.min(Math.max(0, stdoutOffset), fullStdout.length);
  const rawSlicedStdout = fullStdout.slice(safeOffset);
  const { text: slicedStdout, compactedFrames } = compactRepeatedWatchFrames(rawSlicedStdout);

  const inferredStderrOffset =
    explicitStderrOffset !== undefined
      ? explicitStderrOffset
      : resolveStderrOffsetForStdoutOffset(job, safeOffset);
  const safeStderrOffset = Math.min(Math.max(0, inferredStderrOffset), fullStderr.length);
  const slicedStderr = fullStderr.slice(safeStderrOffset);

  job.stderrOffsetByStdoutOffset.set(fullStdout.length, fullStderr.length);
  job.lastReturnedStderrOffset = fullStderr.length;
  void persistJobSnapshot(job);

  const elapsedMs = (job.finishedAtMs ?? Date.now()) - job.startedAtMs;
  const processAlive = job.status === "running" ? isProcessAlive(job.pid) : false;
  const isLongCommand =
    elapsedMs >= 20_000 ||
    /\b(agy|codex|vitest|playwright|gh\s+(?:run\s+watch|pr\s+checks\b.*--watch)|npm\s+run\s+(?:build|guard|lint)|npm\s+(?:test|ci))\b/i.test(
      job.command,
    );
  const suggestedWaitMs = isLongCommand ? 120_000 : 60_000;
  const offsetHint =
    fullStderr.length > 0 && fullStdout.length === 0
      ? `offset=0, stderr_offset=${fullStderr.length}`
      : `offset=${fullStdout.length}`;

  const redirectedInfos = await inspectRedirectedFiles(job);
  const redirectedSummary =
    redirectedInfos.length > 0
      ? `redirected_output_files: ${redirectedInfos.map((r) => `${r.filePath} (${r.sizeBytes} bytes)`).join(", ")}`
      : "";
  const hasStreamJsonResult =
    redirectedInfos.some((r) => r.hasStreamJsonResult) || /"event"\s*:\s*"result"/.test(fullStdout.slice(-4_000));
  const streamJsonStatus =
    hasStreamJsonResult && job.status === "running"
      ? "stream_json_status: result_ready (evento final {\"event\":\"result\"} ja foi gravado; o processo continua aberto — voce ja pode ler o resultado final ou encerrar o job com kill_command)"
      : "";
  let redirectedPreviewSection = "";
  if (!slicedStdout && redirectedInfos.some((r) => r.tailPreview.length > 0)) {
    const blocks = redirectedInfos
      .filter((r) => r.tailPreview.length > 0)
      .map((r) => `[${r.filePath} (${r.sizeBytes} bytes)]:\n${r.tailPreview}`);
    redirectedPreviewSection = `redirected_output_preview:\n${blocks.join("\n\n")}`;
  }

  let stderrSection = "";
  if (slicedStderr) {
    stderrSection = `stderr:\n${slicedStderr}`;
  } else if (job.status !== "running" && job.exitCode !== 0 && fullStderr) {
    const tailStderr = fullStderr.length > 4_000 ? `...(truncado)...\n${fullStderr.slice(-4_000)}` : fullStderr;
    stderrSection = `stderr (resumo final do erro):\n${tailStderr}`;
  }

  const parts = [
    `job_id: ${job.id}`,
    autoCorrectedFrom ? `job_id_autocorrected_from: ${autoCorrectedFrom}` : "",
    `status: ${job.status}`,
    job.exitCode !== null
      ? `exit_code: ${job.exitCode}${job.timedOut ? " (timeout; grupo de processos encerrado)" : ""}`
      : "exit_code: running",
    `pid: ${job.pid ?? "desconhecido"}`,
    `process_alive: ${processAlive}`,
    `elapsed_ms: ${elapsedMs}`,
    `stdout_offset: ${safeOffset}`,
    `next_offset: ${fullStdout.length}`,
    `total_stdout_chars: ${fullStdout.length}`,
    fullStderr.length > 0 ? `stderr_offset: ${safeStderrOffset}` : "",
    fullStderr.length > 0 ? `next_stderr_offset: ${fullStderr.length}` : "",
    fullStderr.length > 0 ? `total_stderr_chars: ${fullStderr.length}` : "",
    compactedFrames > 0 ? `compacted_watch_frames: ${compactedFrames}` : "",
    redirectedSummary,
    streamJsonStatus,
    job.status === "running"
      ? `poll_hint: passe ${offsetHint} e wait_ms=${suggestedWaitMs} (ate 180000) no proximo poll_command (job_id="${job.id}") para ler apenas novas linhas de stdout/stderr sem polling excessivo`
      : "",
    job.maxBufferExceeded
      ? `output_limit_exceeded: true (MCP_COMMAND_MAX_BUFFER_BYTES=${configuredPositiveNumber("MCP_COMMAND_MAX_BUFFER_BYTES", DEFAULT_COMMAND_MAX_BUFFER_BYTES)})`
      : "",
    slicedStdout ? `stdout:\n${slicedStdout}` : "stdout: (vazio)",
    redirectedPreviewSection,
    stderrSection,
    job.errorMessage ? `error_message:\n${job.errorMessage}` : "",
  ].filter(Boolean);
  return commandResult(parts.join("\n"));
}

function executeRipgrep(
  rgArgs: string[],
  cwd: string,
  timeoutMs = 30_000,
  maxLines?: number,
): Promise<CommandExecution> {
  return new Promise((resolve) => {
    let timedOut = false;
    let maxBufferExceeded = false;
    let earlyLineLimitReached = false;
    let spawnError: string | undefined;
    const maxBuffer = configuredPositiveNumber("MCP_COMMAND_MAX_BUFFER_BYTES", DEFAULT_COMMAND_MAX_BUFFER_BYTES);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let capturedNewlines = 0;

    const child = spawn("rg", rgArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const capture = (chunks: Buffer[], chunk: Buffer, isStdout = false): void => {
      if (maxBufferExceeded || earlyLineLimitReached) return;
      const remaining = maxBuffer - capturedBytes;
      if (remaining <= 0) {
        maxBufferExceeded = true;
        child.kill("SIGTERM");
        return;
      }
      const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      chunks.push(slice);
      capturedBytes += slice.length;
      if (chunk.length > remaining) {
        maxBufferExceeded = true;
        child.kill("SIGTERM");
        return;
      }
      if (isStdout && maxLines !== undefined && maxLines > 0) {
        for (let i = 0; i < slice.length; i += 1) {
          if (slice[i] === 0x0a) capturedNewlines += 1;
        }
        if (capturedNewlines >= maxLines) {
          earlyLineLimitReached = true;
          child.kill("SIGTERM");
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdoutChunks, chunk, true));
    child.stderr.on("data", (chunk: Buffer) => capture(stderrChunks, chunk, false));
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
        exitCode: earlyLineLimitReached
          ? 0
          : timedOut
            ? "timeout"
            : maxBufferExceeded
              ? "output_limit"
              : code ?? "desconhecido",
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

/** Resolve ~ e caminhos relativos para um caminho absoluto, auto-resolvendo worktrees em /root/repos/work quando /work/ e omitido. */
function resolvePath(p: string): string {
  const expanded = p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
  const resolved = path.resolve(expanded);
  if (resolved.startsWith("/root/repos/")) {
    const rel = resolved.slice("/root/repos/".length);
    const firstSeg = rel.split("/")[0];
    if (
      firstSeg &&
      firstSeg !== "work" &&
      !existsSync(path.join("/root/repos", firstSeg)) &&
      existsSync(path.join("/root/repos/work", firstSeg))
    ) {
      return path.join("/root/repos/work", rel);
    }
  }
  return resolved;
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

const SNIPPET_LINE_MAX_CHARS = 2_000;

function formatSnippetLine(line: string): string {
  return line.length > SNIPPET_LINE_MAX_CHARS
    ? `${line.slice(0, SNIPPET_LINE_MAX_CHARS)}...(truncado)`
    : line;
}

/** Exibe linhas vizinhas ao redor das primeiras ocorrencias para facilitar a desambiguacao imediata sem read_file extra. */
function buildMultipleOccurrencesHint(content: string, lineNums: number[], oldLineCount: number): string {
  if (lineNums.length === 0) return "";
  const fileLines = content.split("\n");
  const blocks: string[] = [];
  for (const ln of lineNums.slice(0, 3)) {
    const idx = ln - 1;
    const start = Math.max(0, idx - 2);
    const end = Math.min(fileLines.length, idx + Math.min(oldLineCount, 4) + 2);
    const snippet = fileLines
      .slice(start, end)
      .map((line, i) => `  ${start + i + 1} | ${formatSnippetLine(line)}`)
      .join("\n");
    blocks.push(snippet);
  }
  return `\nContexto das primeiras ocorrencias:\n${blocks.join("\n  ---\n")}`;
}

/**
 * Quando old_string nao casa exatamente por diferenca de quebra de linha (CRLF vs LF),
 * espacos em branco invisiveis no fim da linha ou deslocamento uniforme de indentacao a esquerda,
 * localiza o trecho equivalente se (e somente se) for unico no arquivo e ajusta a indentacao de newStr quando aplicavel.
 */
function findNormalizedUniqueMatch(
  content: string,
  oldStr: string,
  newStr?: string,
): { index: number; length: number; adjustedNewStr?: string } | null {
  if (!oldStr) return null;
  if (content.includes("\r\n") && !oldStr.includes("\r\n")) {
    const crlfOld = oldStr.replace(/\n/g, "\r\n");
    const crlfOcc = countOccurrences(content, crlfOld);
    if (crlfOcc.count === 1) {
      return { index: crlfOcc.firstIndex, length: crlfOld.length };
    }
  }
  if (oldStr.includes("\n") && content.length <= 2_000_000) {
    const rawLines = oldStr.split(/\r?\n/);
    if (rawLines.length >= 2 && rawLines.length <= 80) {
      const pattern = rawLines
        .map((line) => `${line.replace(/[ \t]+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?`)
        .join("\\n");
      const re = new RegExp(pattern, "g");
      const first = re.exec(content);
      if (first && !re.exec(content)) {
        return { index: first.index, length: first[0].length };
      }
    }
  }
  // Passo 3 (v1.4.7): tolerancia a diferenca de indentacao horizontal ([ \t]*) quando o trecho e unico no arquivo.
  const trimmedTotal = oldStr.trim();
  if (trimmedTotal.length >= 10 && content.length <= 2_000_000) {
    const rawOldLines = oldStr.split(/\r?\n/);
    const nonEmptyCount = rawOldLines.filter((l) => l.trim().length > 0).length;
    if (
      rawOldLines.length >= 1 &&
      rawOldLines.length <= 80 &&
      nonEmptyCount >= 1 &&
      (rawOldLines.length >= 2 || /^[ \t]+/.test(oldStr))
    ) {
      const linePatterns = rawOldLines.map((line) => {
        const t = line.trim();
        if (!t) return "[ \\t]*\\r?";
        return `[ \\t]*${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?`;
      });
      const fullPattern = `(?:^|\\n)(${linePatterns.join("\\n")})(?=\\r?\\n|$)`;
      const re = new RegExp(fullPattern, "g");
      const first = re.exec(content);
      if (first && !re.exec(content)) {
        const matchedBlock = first[1];
        const matchIndex = first.index + (first[0].startsWith("\n") ? 1 : 0);
        let adjustedNewStr: string | undefined;
        if (newStr !== undefined) {
          const matchedLines = matchedBlock.split(/\r?\n/);
          const deltas: number[] = [];
          let onlySpacesUsed = true;
          for (let k = 0; k < rawOldLines.length && k < matchedLines.length; k += 1) {
            if (rawOldLines[k].trim().length === 0) continue;
            const oldLead = rawOldLines[k].match(/^[ \t]*/)?.[0] ?? "";
            const fileLead = matchedLines[k].match(/^[ \t]*/)?.[0] ?? "";
            if (oldLead.includes("\t") || fileLead.includes("\t")) {
              onlySpacesUsed = false;
              break;
            }
            deltas.push(oldLead.length - fileLead.length);
          }
          if (onlySpacesUsed && deltas.length > 0 && deltas.every((d) => d === deltas[0]) && deltas[0] !== 0) {
            const delta = deltas[0];
            const rawNewLines = newStr.split("\n");
            if (delta < 0) {
              const pad = " ".repeat(-delta);
              adjustedNewStr = rawNewLines.map((nl) => (nl.trim().length > 0 ? `${pad}${nl}` : nl)).join("\n");
            } else {
              const canUnindentAll = rawNewLines.every(
                (nl) => nl.trim().length === 0 || (nl.match(/^ */)?.[0].length ?? 0) >= delta,
              );
              if (canUnindentAll) {
                adjustedNewStr = rawNewLines.map((nl) => (nl.trim().length > 0 ? nl.slice(delta) : nl)).join("\n");
              }
            }
          }
        }
        return { index: matchIndex, length: matchedBlock.length, adjustedNewStr };
      }
    }
  }
  // Passo 4 (v1.4.8): normalizacao de contra-barras sobre-escapadas em scripts Bash/Markdown (ex.: "\\\\\n" -> "\\\n", "\\\\\"" -> "\\\"").
  if (oldStr.includes("\\\\")) {
    let candidateOld = oldStr;
    let candidateNew = newStr;
    for (let pass = 0; pass < 2; pass += 1) {
      if (!candidateOld.includes("\\\\")) break;
      candidateOld = candidateOld.replace(/\\\\/g, "\\");
      if (candidateNew !== undefined) {
        candidateNew = candidateNew.replace(/\\\\/g, "\\");
      }
      const unescapedOcc = countOccurrences(content, candidateOld);
      if (unescapedOcc.count === 1) {
        return {
          index: unescapedOcc.firstIndex,
          length: candidateOld.length,
          adjustedNewStr: candidateNew,
        };
      }
      if (candidateOld.includes('\\"')) {
        const quoteUnescapedOld = candidateOld.replace(/\\\\"/g, '\\"');
        if (quoteUnescapedOld !== candidateOld) {
          const quoteOcc = countOccurrences(content, quoteUnescapedOld);
          if (quoteOcc.count === 1) {
            return {
              index: quoteOcc.firstIndex,
              length: quoteUnescapedOld.length,
              adjustedNewStr: candidateNew !== undefined ? candidateNew.replace(/\\\\"/g, '\\"') : undefined,
            };
          }
        }
      }
    }
  }
  return null;
}

/** Quando old_string nao e encontrado exatamente, procura uma linha parecida para orientar a correcao. */
function buildMissingOldStringHint(content: string, oldStr: string): string {
  const rawOldLines = oldStr.split("\n");
  const indexedOldLines = rawOldLines
    .map((raw, idx) => ({ trimmed: raw.trim(), idx }))
    .filter((item) => item.trimmed.length >= 4);
  if (indexedOldLines.length === 0) return "";

  const oldLines = indexedOldLines.map((item) => item.trimmed);
  const fileLines = content.split("\n");

  const rawTokens = Array.from(new Set(oldStr.match(/[A-Za-z0-9_\u00C0-\u017F-]{3,}/g) ?? [])).slice(0, 36);
  const tokenSpecs = rawTokens.map((raw) => {
    const lower = raw.toLowerCase();
    const isDistinctive =
      /[A-Z]/.test(raw.slice(1)) || /[0-9_-]/.test(raw) || raw.length >= 9;
    return { lower, weight: isDistinctive ? 3 : raw.length >= 4 ? 1 : 0.5, isDistinctive };
  });

  const scoreWindowAt = (startLineIdx: number): { score: number; distinctiveHits: number } => {
    const winStart = Math.max(0, startLineIdx - 2);
    const winEnd = Math.min(fileLines.length, startLineIdx + Math.min(rawOldLines.length + 3, 10));
    const winText = fileLines.slice(winStart, winEnd).join("\n").toLowerCase();
    let score = 0;
    let distinctiveHits = 0;
    for (const tk of tokenSpecs) {
      if (winText.includes(tk.lower)) {
        score += tk.weight;
        if (tk.isDistinctive) distinctiveHits += 1;
      }
    }
    for (const ol of oldLines.slice(0, 8)) {
      if (winText.includes(ol.toLowerCase())) {
        score += 2.5;
      }
    }
    return { score, distinctiveHits };
  };

  let matchIdx = -1;
  let step1BestScore = 0;
  let step1FoundUnique = false;

  // Passo 1: avalia linhas candidatas de old_string priorizando linhas unicas/raras e maior sobreposicao de janela.
  const candidates = [...indexedOldLines.slice(0, 12)].sort((a, b) => b.trimmed.length - a.trimmed.length);
  for (const candObj of candidates) {
    const cand = candObj.trimmed;
    if (cand.length < 4) continue;
    const candLower = cand.toLowerCase();
    const matchingIndices: number[] = [];
    for (let i = 0; i < fileLines.length; i += 1) {
      if (fileLines[i].includes(cand) || fileLines[i].toLowerCase().includes(candLower)) {
        matchingIndices.push(i);
        if (matchingIndices.length >= 40) break;
      }
    }
    if (matchingIndices.length === 0) continue;

    const rarityWeight = matchingIndices.length === 1 ? 18 : 6 / Math.sqrt(matchingIndices.length);
    for (const fileIdx of matchingIndices) {
      const estStart = rawOldLines.length > 1 ? Math.max(0, fileIdx - candObj.idx) : fileIdx;
      const win = scoreWindowAt(estStart);
      const totalCandidateScore = rarityWeight + win.score;
      if (totalCandidateScore > step1BestScore) {
        step1BestScore = totalCandidateScore;
        matchIdx = estStart;
        step1FoundUnique = matchingIndices.length === 1;
      }
    }
  }

  // Passo 2: ancora estrutural de propriedade/chave (ex.: sidebarDescription=, subtitle=, | **R1 — ...)
  if (matchIdx === -1) {
    for (const lineObj of indexedOldLines.slice(0, 5)) {
      const lineText = lineObj.trimmed;
      const propMatch =
        lineText.match(/^([a-zA-Z_$][a-zA-Z0-9_$-]{2,}\s*[:=])/) ??
        lineText.match(/^(\|\s*\*\*[^|]{2,40}\*\*)/) ??
        lineText.match(/^((?:it|test|describe)\s*\(\s*['"`][^'"`]{4,35})/);
      if (propMatch) {
        const anchorLower = propMatch[1].toLowerCase();
        const matchingIndices: number[] = [];
        for (let i = 0; i < fileLines.length; i += 1) {
          if (fileLines[i].toLowerCase().includes(anchorLower)) {
            matchingIndices.push(i);
          }
        }
        if (matchingIndices.length === 1) {
          matchIdx = Math.max(0, matchingIndices[0] - lineObj.idx);
          step1FoundUnique = true;
          break;
        }
      }
    }
  }

  // Passo 3: pontuacao ponderada por identificadores, numeros e estrutura (suporta janelas multi-linha).
  // Tambem executa quando o Passo 1 so encontrou uma linha generica repetida (ex.: 'status: EXECUTING')
  // para que blocos com tokens distintivos (ex.: 'WP-PLAN-005') tenham prioridade.
  if ((matchIdx === -1 || !step1FoundUnique) && tokenSpecs.length >= 1) {
    const bulletPrefix = oldLines[0].match(/^([-*+]|\d+\.|\|)\s+/)?.[0];
    const windowLines = Math.min(Math.max(1, oldLines.length), 4);

    let bestScore = 0;
    let bestLine = -1;
    let bestDistinctiveHits = 0;
    for (let i = 0; i < fileLines.length; i += 1) {
      const firstLineTrim = fileLines[i].trimStart();
      if (firstLineTrim.length < 3) continue;
      const windowText =
        windowLines > 1
          ? fileLines.slice(i, Math.min(fileLines.length, i + windowLines)).join("\n").toLowerCase()
          : firstLineTrim.toLowerCase();
      let rawScore = 0;
      let distinctiveHits = 0;
      let totalHits = 0;
      for (const tk of tokenSpecs) {
        if (windowText.includes(tk.lower)) {
          rawScore += tk.weight;
          totalHits += 1;
          if (tk.isDistinctive) distinctiveHits += 1;
        }
      }
      if (distinctiveHits === 0 && totalHits < 2) continue;
      if (bulletPrefix && firstLineTrim.startsWith(bulletPrefix)) {
        rawScore *= 1.35;
      }
      const lengthNorm = Math.pow(Math.max(60, windowText.length), 0.15);
      const finalScore = rawScore / lengthNorm;
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestLine = i;
        bestDistinctiveHits = distinctiveHits;
      }
    }
    if (bestLine !== -1) {
      if (matchIdx === -1) {
        matchIdx = bestLine;
      } else {
        const step1Win = scoreWindowAt(matchIdx);
        if (bestDistinctiveHits > step1Win.distinctiveHits) {
          matchIdx = bestLine;
        }
      }
    }
  }

  if (matchIdx === -1) return "";

  const start = Math.max(0, matchIdx - 2);
  const end = Math.min(fileLines.length, matchIdx + Math.min(rawOldLines.length + 4, 12));
  const snippet = fileLines
    .slice(start, end)
    .map((line, i) => `  ${start + i + 1} | ${formatSnippetLine(line)}`)
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

const STRUCTURAL_HINT_SUBDIRS = [
  "services",
  "packages",
  "apps",
  "modules",
  "criaelo",
  "criaelo/services",
  "criaelo/packages",
  "criaelo/apps",
  "work",
  "src",
];

/**
 * Quando o agente passa um glob ao final de `path` (ex.: `/dir/scripts/crm-p1-*.test.mjs`),
 * separa automaticamente o diretorio base existente do sufixo glob, evitando erro ENOENT.
 */
function resolveTargetAndTrailingGlob(rawPath: string | undefined): { target: string; extractedGlob?: string } {
  if (!rawPath) return { target: os.homedir() };
  const resolved = resolvePath(rawPath);
  if (existsSync(resolved)) {
    return { target: resolved };
  }
  if (!/[*?{]/.test(resolved)) {
    return { target: resolved };
  }
  const segments = resolved.split(path.sep);
  const firstGlobIdx = segments.findIndex((seg) => /[*?{]/.test(seg));
  if (firstGlobIdx <= 0) {
    return { target: resolved };
  }
  const baseDir = segments.slice(0, firstGlobIdx).join(path.sep) || path.sep;
  const extractedGlob = segments.slice(firstGlobIdx).join("/");
  return { target: baseDir, extractedGlob };
}

function computeBoundedEditDistance(a: string, b: string, maxDist = 3): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;
  const prev = new Array<number>(lb + 1);
  const curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;
  for (let i = 1; i <= la; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return maxDist + 1;
    for (let j = 0; j <= lb; j += 1) prev[j] = curr[j];
  }
  return prev[lb];
}

function isCloseTypoOrWorktreeMatch(candidateLower: string, missingLower: string): boolean {
  if (!candidateLower || !missingLower) return false;
  if (candidateLower === missingLower) return true;
  const minLen = Math.min(candidateLower.length, missingLower.length);
  if (minLen >= 5) {
    const maxAllowed = minLen >= 14 ? 3 : 2;
    if (computeBoundedEditDistance(candidateLower, missingLower, maxAllowed) <= maxAllowed) {
      return true;
    }
  }
  if (
    missingLower.length >= 8 &&
    candidateLower.startsWith(`${missingLower}-`) &&
    /^-\d{6,8}/.test(candidateLower.slice(missingLower.length))
  ) {
    return true;
  }
  return false;
}

interface MissingPathDetails {
  closestParent: string;
  suggestions: string[];
  availableEntries: string[];
}

async function inspectMissingPathDetails(target: string): Promise<MissingPathDetails | null> {
  let parent = path.dirname(target);
  while (parent !== path.dirname(parent)) {
    try {
      const pStat = await fs.stat(parent);
      if (pStat.isDirectory()) {
        const relMissing = path.relative(parent, target);
        const missingChild = relMissing.split(path.sep)[0] || path.basename(target);
        const missingRemainder =
          relMissing.length > missingChild.length ? relMissing.slice(missingChild.length + 1) : "";
        const missingLower = missingChild.toLowerCase();
        const tokens = missingLower.split(/[-_.\s/]+/).filter((t) => t.length >= 2);

        const candidates: string[] = [];
        for (const sub of STRUCTURAL_HINT_SUBDIRS) {
          const fullCandidate = path.join(parent, sub, relMissing);
          if (existsSync(fullCandidate)) {
            candidates.push(fullCandidate);
          } else if (missingRemainder) {
            const baseCandidate = path.join(parent, sub, missingChild);
            if (existsSync(baseCandidate)) {
              candidates.push(baseCandidate);
            }
          }
        }

        const dirents = (await fs.readdir(parent, { withFileTypes: true })).filter(
          (e) => !DEFAULT_SEARCH_IGNORE_DIRS.includes(e.name),
        );

        const scored = dirents.map((e) => {
          const nameLower = e.name.toLowerCase();
          let score = 0;
          const isTypoMatch = isCloseTypoOrWorktreeMatch(nameLower, missingLower);
          if (nameLower === missingLower) score += 100;
          else if (isTypoMatch) score += 75;
          else if (
            nameLower.includes(missingLower) ||
            (missingLower.length >= 3 && missingLower.includes(nameLower))
          ) {
            score += 50;
          }
          for (const tk of tokens) {
            if (nameLower.includes(tk)) score += 10;
          }
          if (!missingRemainder && isTypoMatch && candidates.length < 3) {
            candidates.push(path.join(parent, e.name));
          }
          if (score >= 20 && missingRemainder && e.isDirectory()) {
            const subCandidate = path.join(parent, e.name, missingRemainder);
            if (existsSync(subCandidate)) {
              score += 80;
              if (candidates.length < 3) candidates.push(subCandidate);
            } else if (isTypoMatch && !missingRemainder.includes(path.sep)) {
              try {
                const subDirents = readdirSync(path.join(parent, e.name));
                const remLower = missingRemainder.toLowerCase();
                const closeSub = subDirents.find((sn) => isCloseTypoOrWorktreeMatch(sn.toLowerCase(), remLower));
                if (closeSub) {
                  score += 80;
                  if (candidates.length < 3) candidates.push(path.join(parent, e.name, closeSub));
                }
              } catch {
                // Ignora erro de leitura no subdiretorio candidato.
              }
            }
          }
          return { dirent: e, score };
        });

        scored.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          const aDir = a.dirent.isDirectory() ? 1 : 0;
          const bDir = b.dirent.isDirectory() ? 1 : 0;
          if (bDir !== aDir) return bDir - aDir;
          return entryCollator.compare(a.dirent.name, b.dirent.name);
        });

        for (const item of scored) {
          if (candidates.length >= 3) break;
          if (item.score < 30) break;
          if (!missingRemainder) {
            candidates.push(path.join(parent, item.dirent.name));
          } else if (item.dirent.isDirectory()) {
            const subCand = path.join(parent, item.dirent.name, missingRemainder);
            if (existsSync(subCand)) {
              candidates.push(subCand);
            }
          }
        }

        const availableEntries = scored
          .slice(0, 25)
          .map(({ dirent }) => (dirent.isDirectory() ? `${dirent.name}/` : dirent.name));
        const suggestions = Array.from(new Set(candidates)).slice(0, 3);
        return {
          closestParent: parent,
          suggestions,
          availableEntries,
        };
      }
    } catch {
      // Continua subindo para o diretorio pai.
    }
    parent = path.dirname(parent);
  }
  return null;
}

/** Valida que o caminho existe e, em caso de ENOENT, informa o diretorio pai existente mais proximo, caminhos alternativos e entradas similares. */
async function assertTargetExistsWithHint(target: string, toolName: string) {
  try {
    return await fs.stat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      const details = await inspectMissingPathDetails(target);
      if (details) {
        const suggestionHint =
          details.suggestions.length > 0 ? ` Sugestao encontrada: ${details.suggestions.join(", ")}.` : "";
        const hint =
          details.availableEntries.length > 0
            ? ` Entradas disponiveis em ${details.closestParent}: ${details.availableEntries.join(", ")}.`
            : "";
        throw new Error(
          `Caminho inexistente em ${toolName}: ${target}. Diretorio pai existente mais proximo: ${details.closestParent}.${suggestionHint}${hint}`,
        );
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
  // Ignora diretorios de dados binarios do PostgreSQL em worktrees, a menos que apontados explicitamente.
  const pgIgnorePatterns = ["pg_wal", "pg_multixact", "pg_xact", "postgres-*/data", "*pgdata*"];
  for (const pgPat of pgIgnorePatterns) {
    const baseToken = pgPat.replace(/[*\/]/g, "");
    if (!target.includes(baseToken) && !userGlobs.some((g) => g.includes(baseToken))) {
      args.push(`--glob=!**/${pgPat}/**`);
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
  allow_missing?: boolean;
}

async function readSingleFileFormatted(params: FileSliceParams): Promise<string> {
  const target = resolvePath(params.path);
  const hasLineMode = params.offset !== undefined || params.limit !== undefined;
  const hasCharMode = params.char_offset !== undefined || params.char_limit !== undefined;
  if (hasLineMode && hasCharMode) {
    throw new Error("Use paginacao por linhas (offset/limit) OU por caracteres (char_offset/char_limit), nao ambas na mesma chamada.");
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  if (params.allow_missing) {
    try {
      stat = await fs.stat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        const details = await inspectMissingPathDetails(target);
        return [
          `path: ${target}`,
          `exists: false`,
          `status: missing`,
          details ? `closest_parent: ${details.closestParent}` : "",
          details && details.suggestions.length > 0 ? `suggestions: ${details.suggestions.join(", ")}` : "",
          "",
          "(arquivo inexistente — verificado sem erro via allow_missing=true)",
        ]
          .filter(Boolean)
          .join("\n");
      }
      throw err;
    }
  } else {
    stat = await assertTargetExistsWithHint(target, "read_file");
  }
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
      "Inicia um comando de shell (bash) em background com job_id e aguarda opcionalmente wait_ms (padrao 10000ms, max 120000ms). " +
      "Use SEMPRE para builds, deploys, suites de teste (Playwright, Vitest), gh run watch (prefira 'gh run watch <id> --interval 15'), pipelines encadeados (lint && build && test) ou invocacao de subagentes CLI (agy) sem travar a chamada HTTP. " +
      "Se retornar status: running, chame poll_command passando job_id, offset=next_offset e wait_ms=60000..180000 para acompanhar apenas a saida nova sem polling excessivo.",
    schema: {
      command: z.string().describe("Comando de shell completo a executar em background."),
      cwd: z.string().optional().describe("Diretorio de trabalho para o comando. Padrao: diretorio home."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(3_600_000)
        .optional()
        .describe("Timeout total do job em milissegundos (max 3600000 / 60 min). Padrao: 1200000 (20 min)."),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(120_000)
        .optional()
        .describe("Tempo inicial de espera em ms antes de retornar se o comando ainda estiver rodando (max 120000). Padrao: 10000 (valores entre 1000 e 9999 sao elevados para 10000ms automaticamente, retornando imediatamente assim que o comando concluir)."),
    },
    handler: async (args) => {
      const command = args.command as string;
      const cwd = args.cwd ? resolvePath(args.cwd as string) : os.homedir();
      const cwdStat = await assertTargetExistsWithHint(cwd, "start_command (cwd)");
      if (!cwdStat.isDirectory()) {
        throw new Error(`O diretorio de trabalho (cwd) informado em start_command nao e um diretorio: ${cwd}`);
      }
      const timeoutMs = (args.timeout_ms as number | undefined) ?? 1_200_000;
      const requestedWaitMs = (args.wait_ms as number | undefined) ?? 10_000;
      const waitMs = requestedWaitMs >= 1_000 && requestedWaitMs < 10_000 ? 10_000 : requestedWaitMs;
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
      "aguardando ate wait_ms pela conclusao (padrao 60000ms, max 180000ms), ou encerra todo o grupo de processos se kill=true. " +
      "BOAS PRATICAS: passe sempre offset com o valor de next_offset retornado na chamada anterior (o stderr tambem sera fatiado incrementalmente de forma automatica) e use wait_ms entre 60000 e 180000 para jobs longos (retorna imediatamente assim que o job concluir).",
    schema: {
      job_id: z
        .string()
        .optional()
        .describe("ID do job retornado por start_command (opcional quando ha apenas 1 job em execucao)."),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(180_000)
        .optional()
        .describe("Tempo maximo de espera por conclusao nesta chamada em ms (max 180000 / 3 min). Padrao: 60000 (1 min)."),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Offset em caracteres do stdout. Passe SEMPRE o next_offset retornado no poll anterior para receber apenas saida nova (stdout e stderr). Padrao: 0."),
      stderr_offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Offset explicito em caracteres do stderr (opcional; se omitido, acompanha automaticamente o avanco de offset)."),
      kill: z
        .boolean()
        .optional()
        .describe("Se true, encerra o grupo de processos do job (SIGTERM -> SIGKILL). Padrao: false."),
    },
    handler: async (args) => {
      const jobId = args.job_id as string | undefined;
      const kill = (args.kill as boolean | undefined) ?? false;
      const { job, autoCorrectedFrom, activeJobsHint } = await resolveJobWithTypoTolerance(jobId, !kill);
      if (!job) {
        throw new Error(`Job nao encontrado ou expirado: ${jobId ?? "(nenhum job_id informado)"}.${activeJobsHint}`);
      }
      const offset = (args.offset as number | undefined) ?? 0;
      const stderrOffset = args.stderr_offset as number | undefined;
      if (kill) {
        if (job.status === "running") {
          job.terminate(true);
          await waitForJob(job, 2_000);
        } else {
          killProcessGroup(job.pid, "SIGTERM");
        }
      } else {
        const waitMs = (args.wait_ms as number | undefined) ?? 60_000;
        await waitForJob(job, waitMs);
      }
      return formatJobResult(job, offset, stderrOffset, autoCorrectedFrom);
    },
  },

  {
    name: "read_file",
    title: "Ler arquivo",
    description:
      "Le um unico arquivo de texto com metadata e paginacao. offset/limit operam por linhas; char_offset/char_limit operam por caracteres e sao uteis para arquivos minificados ou linhas muito longas. " +
      "DICAS: (1) se precisar ler 2 ou mais arquivos (ou 2 ou mais faixas offset/limit diferentes do mesmo arquivo), prefira read_files para ler tudo em paralelo em uma unica chamada. " +
      "(2) Se o objetivo for apenas checar se o arquivo existe (ou ler caso exista sem gerar erro ENOENT), passe allow_missing=true ou use stat_path.",
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
      allow_missing: z
        .boolean()
        .optional()
        .describe("Se true, retorna exists: false sem lancar erro caso o arquivo nao exista. Padrao: false."),
    },
    handler: async (args) => {
      const formatted = await readSingleFileFormatted({
        path: args.path as string,
        offset: args.offset as number | undefined,
        limit: args.limit as number | undefined,
        char_offset: args.char_offset as number | undefined,
        char_limit: args.char_limit as number | undefined,
        allow_missing: args.allow_missing as boolean | undefined,
      });
      return textResult(formatted);
    },
  },

  {
    name: "stat_path",
    title: "Verificar existencia e metadados de caminho(s)",
    description:
      "Inspeciona rapidamente 1 ou mais caminhos (ate 50 em paralelo via paths) para verificar se existem, seu tipo (file, directory, symlink, missing), tamanho em bytes, mtime e sugestoes de caminhos similares quando ausente — NUNCA falha com erro ENOENT. " +
      "Use SEMPRE antes de criar arquivos opcionais (ex.: AGENTS.md, workflows, schemas) ou para validar nomes de worktrees/arquivos sem poluir a sessao com erros.",
    schema: {
      path: z.string().optional().describe("Caminho unico a verificar (opcional se paths for informado)."),
      paths: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .optional()
        .describe("Lista de caminhos (ate 50) para verificar existencia e metadados de uma vez."),
    },
    handler: async (args) => {
      const singlePath = typeof args.path === "string" && args.path.trim() ? [args.path.trim()] : [];
      const multiPaths = Array.isArray(args.paths) ? (args.paths as string[]).map((p) => p.trim()).filter(Boolean) : [];
      const rawTargets = Array.from(new Set([...singlePath, ...multiPaths]));
      if (rawTargets.length === 0) {
        throw new Error("Informe 'path' ou 'paths' em stat_path.");
      }
      const blocks = await Promise.all(
        rawTargets.map(async (rawTarget) => {
          const target = resolvePath(rawTarget);
          try {
            const lstat = await fs.lstat(target);
            const stat = lstat.isSymbolicLink() ? await fs.stat(target).catch(() => lstat) : lstat;
            const kind = lstat.isSymbolicLink()
              ? stat.isDirectory()
                ? "symlink->directory"
                : "symlink->file"
              : stat.isDirectory()
                ? "directory"
                : stat.isFile()
                  ? "file"
                  : "other";
            return [
              `path: ${target}`,
              `exists: true`,
              `type: ${kind}`,
              `size_bytes: ${stat.size}`,
              `mtime: ${stat.mtime.toISOString()}`,
            ].join("\n");
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
              const details = await inspectMissingPathDetails(target);
              return [
                `path: ${target}`,
                `exists: false`,
                `type: missing`,
                details ? `closest_parent: ${details.closestParent}` : "",
                details && details.suggestions.length > 0 ? `suggestions: ${details.suggestions.join(", ")}` : "",
                details && details.availableEntries.length > 0
                  ? `available_in_parent: ${details.availableEntries.slice(0, 12).join(", ")}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n");
            }
            throw err;
          }
        }),
      );
      return textResult(blocks.join("\n\n"));
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
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(15)
        .optional()
        .describe("Profundidade maxima opcional de subdiretorios a percorrer."),
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
      const { target, extractedGlob } = resolveTargetAndTrailingGlob(args.path as string | undefined);
      const globs = [...((args.globs as string[] | undefined) ?? []), ...(extractedGlob ? [extractedGlob] : [])];
      const fixedStrings = (args.fixed_strings as boolean | undefined) ?? false;
      const caseSensitive = args.case_sensitive as boolean | undefined;
      const hidden = (args.hidden as boolean | undefined) ?? false;
      const contextLines = (args.context_lines as number | undefined) ?? 0;
      const explicitMaxDepth = args.max_depth as number | undefined;
      const maxDepth = explicitMaxDepth ?? (target === "/root/repos/work" ? 3 : undefined);
      const maxResults = (args.max_results as number | undefined) ?? 200;

      await assertTargetExistsWithHint(target, "search_code");

      const ignoreArgs = buildSearchIgnoreGlobs(target, globs);
      const earlyStopLines = (maxResults + 100) * Math.max(1, contextLines * 2 + 2);
      const buildRgArgs = (useFixedStrings: boolean): string[] => {
        const rgArgs: string[] = [
          "--line-number",
          "--with-filename",
          "--color=never",
          "--no-heading",
          "--max-filesize=2M",
        ];
        if (maxDepth !== undefined) {
          rgArgs.push(`--max-depth=${maxDepth}`);
        }
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

      let execution = await executeRipgrep(buildRgArgs(fixedStrings), os.homedir(), 30_000, earlyStopLines);
      let usedFallbackFixedStrings = false;

      // Se o agente esqueceu fixed_strings=true ao buscar codigo com parenteses/chaves (ex.: "Inter(", "icons: {"),
      // faz fallback automatico para --fixed-strings em vez de falhar com regex parse error.
      if (!fixedStrings && execution.exitCode === 2 && /regex parse error/i.test(execution.stderr)) {
        execution = await executeRipgrep(buildRgArgs(true), os.homedir(), 30_000, earlyStopLines);
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
            ...(extractedGlob ? [`extracted_glob: ${extractedGlob}`] : []),
            `pattern: ${pattern}`,
            `mode: ${modeLabel}`,
            `matches: 0`,
            `truncated: false`,
            "",
            "(nenhuma ocorrencia encontrada)",
          ].join("\n"),
        );
      }

      const hasPartialTimeoutMatches = execution.timedOut && execution.stdout.trim().length > 0;
      if (execution.exitCode !== 0 && execution.exitCode !== 1 && !hasPartialTimeoutMatches) {
        const errText = execution.stderr.trim() || execution.errorMessage || `ripgrep falhou com codigo ${execution.exitCode}`;
        throw new Error(`Erro ao executar search_code (rg): ${errText}`);
      }

      const rawLines = execution.stdout.replace(/\r?\n$/, "");
      const lines = rawLines ? rawLines.split("\n") : [];
      const truncated = lines.length > maxResults || hasPartialTimeoutMatches;
      const selectedLines = lines.length > maxResults ? lines.slice(0, maxResults) : lines;

      const header = [
        `exit_code: 0`,
        `path: ${target}`,
        extractedGlob ? `extracted_glob: ${extractedGlob}` : "",
        `pattern: ${pattern}`,
        `mode: ${modeLabel}`,
        `returned_lines: ${selectedLines.length}`,
        `total_lines: ${lines.length}`,
        `truncated: ${truncated}`,
        hasPartialTimeoutMatches
          ? "timed_out_partial: true (busca atingiu 30s em diretorio grande; exibindo resultados parciais encontrados)"
          : "",
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
      const { target, extractedGlob } = resolveTargetAndTrailingGlob(args.path as string | undefined);
      const explicitPattern = (args.pattern as string | undefined)?.trim();
      const rawPattern = explicitPattern || extractedGlob;
      const globs = [
        ...((args.globs as string[] | undefined) ?? []),
        ...(explicitPattern && extractedGlob ? [extractedGlob] : []),
      ];
      const explicitMaxDepth = args.max_depth as number | undefined;
      const maxDepth = explicitMaxDepth ?? (target === "/root/repos/work" ? 3 : undefined);
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
      const allTermsAreStrictGlobs = patternTerms.length > 0 && patternTerms.every((t) => /[*?[\]{}]/.test(t));
      const canPushPatternToRg = patternTerms.length > 0 && patternTerms.every((t) => !t.startsWith("!"));

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
      if (canPushPatternToRg) {
        const flag = caseSensitive ? "--glob" : "--iglob";
        for (const term of patternTerms) {
          const hasGlob = /[*?[\]{}]/.test(term);
          if (hasGlob) {
            const normalizedGlob = normalizeFindGlob(term);
            rgArgs.push(`${flag}=${normalizedGlob}`);
            if (!term.includes("/") && term.startsWith("*") && term.endsWith("*")) {
              rgArgs.push(`${flag}=**/${normalizedGlob}/**`);
            }
          } else {
            const clean = term.replace(/^\/+|\/+$/g, "");
            if (clean) {
              if (clean.includes("/")) {
                rgArgs.push(`${flag}=**/*${clean}*`);
                rgArgs.push(`${flag}=**/*${clean}*/**`);
              } else {
                rgArgs.push(`${flag}=*${clean}*`);
                rgArgs.push(`${flag}=**/*${clean}*/**`);
              }
            }
          }
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

      if (patternTerms.length > 0 && !allTermsAreStrictGlobs) {
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
      const stat = await assertTargetExistsWithHint(target, "edit_file");
      if (!stat.isFile()) {
        throw new Error(`O caminho nao e um arquivo regular: ${target}`);
      }
      const content = await fs.readFile(target, "utf8");
      const { count: occurrences, firstIndex } = countOccurrences(content, oldStr);
      if (occurrences === 0) {
        if (!replaceAll) {
          const normalized = findNormalizedUniqueMatch(content, oldStr, newStr);
          if (normalized) {
            const replacementStr = normalized.adjustedNewStr ?? newStr;
            const updatedNormalized = `${content.slice(0, normalized.index)}${replacementStr}${content.slice(normalized.index + normalized.length)}`;
            await fs.writeFile(target, updatedNormalized, "utf8");
            return textResult(`Arquivo editado: ${target} (1 substituicao(oes)).`);
          }
          if (newStr.trim().length >= 15 && countOccurrences(content, newStr).count === 1) {
            return textResult(`Arquivo editado: ${target} (0 substituicoes — new_string ja estava aplicado de forma idempotente).`);
          }
        }
        const hint = buildMissingOldStringHint(content, oldStr);
        throw new Error(`old_string nao encontrado em ${target}.${hint}`);
      }
      if (occurrences > 1 && !replaceAll) {
        const lineNums = findOccurrenceLines(content, oldStr);
        const linesLabel = lineNums.length > 0 ? ` (linhas ${lineNums.join(", ")}${occurrences > lineNums.length ? ", ..." : ""})` : "";
        const contextHint = buildMultipleOccurrencesHint(content, lineNums, countLines(oldStr));
        throw new Error(
          `old_string aparece ${occurrences} vezes em ${target}${linesLabel}. Inclua linhas vizinhas para torna-lo unico ou use replace_all=true.${contextHint}`,
        );
      }
      if (
        occurrences === 1 &&
        !replaceAll &&
        newStr !== oldStr &&
        newStr.trim().length >= 15 &&
        newStr.includes(oldStr) &&
        countOccurrences(content, newStr).count === 1
      ) {
        return textResult(`Arquivo editado: ${target} (0 substituicoes — new_string ja estava aplicado de forma idempotente).`);
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
      const stat = await assertTargetExistsWithHint(target, "multi_edit_file");
      if (!stat.isFile()) {
        throw new Error(`O caminho nao e um arquivo regular: ${target}`);
      }
      let updated = await fs.readFile(target, "utf8");
      let totalReplacements = 0;
      const failures: string[] = [];
      const passedEditNumbers: number[] = [];

      for (let i = 0; i < edits.length; i += 1) {
        const edit = edits[i];
        if (edit.old_string === edit.new_string) {
          passedEditNumbers.push(i + 1);
          continue;
        }
        const replaceAll = edit.replace_all ?? false;
        const editPrefix =
          i > 0 && failures.length === 0
            ? `Edicao #${i + 1} (edicoes #1..#${i} validadas OK)`
            : `Edicao #${i + 1}`;
        const { count: occurrences, firstIndex } = countOccurrences(updated, edit.old_string);
        if (occurrences === 0) {
          const alreadyAppliedInBatch =
            i > 0 &&
            edits
              .slice(0, i)
              .some((prev) => prev.old_string === edit.old_string && prev.new_string === edit.new_string);
          if (alreadyAppliedInBatch) {
            passedEditNumbers.push(i + 1);
            continue;
          }
          if (!replaceAll) {
            const normalized = findNormalizedUniqueMatch(updated, edit.old_string, edit.new_string);
            if (normalized) {
              const replacementStr = normalized.adjustedNewStr ?? edit.new_string;
              updated = `${updated.slice(0, normalized.index)}${replacementStr}${updated.slice(normalized.index + normalized.length)}`;
              totalReplacements += 1;
              passedEditNumbers.push(i + 1);
              continue;
            }
            if (edit.new_string.trim().length >= 15 && countOccurrences(updated, edit.new_string).count === 1) {
              passedEditNumbers.push(i + 1);
              continue;
            }
          }
          if (failures.length < 4) {
            const hint = buildMissingOldStringHint(updated, edit.old_string);
            failures.push(`${editPrefix}: old_string nao encontrado em ${target}. Nenhuma alteracao foi gravada.${hint}`);
          }
          continue;
        }
        if (occurrences > 1 && !replaceAll) {
          const remainingSameOldStringEdits = edits
            .slice(i)
            .filter(
              (candidate) =>
                !candidate.replace_all &&
                candidate.old_string === edit.old_string &&
                candidate.old_string !== candidate.new_string,
            ).length;
          if (remainingSameOldStringEdits !== occurrences) {
            if (failures.length < 4) {
              const lineNums = findOccurrenceLines(updated, edit.old_string);
              const linesLabel = lineNums.length > 0 ? ` (linhas ${lineNums.join(", ")}${occurrences > lineNums.length ? ", ..." : ""})` : "";
              const contextHint = buildMultipleOccurrencesHint(updated, lineNums, countLines(edit.old_string));
              failures.push(
                `${editPrefix}: old_string aparece ${occurrences} vezes em ${target}${linesLabel}. Inclua linhas vizinhas para torna-lo unico ou use replace_all=true. Nenhuma alteracao foi gravada.${contextHint}`,
              );
            }
            continue;
          }
        }
        if (
          occurrences === 1 &&
          !replaceAll &&
          edit.new_string !== edit.old_string &&
          edit.new_string.trim().length >= 15 &&
          edit.new_string.includes(edit.old_string) &&
          countOccurrences(updated, edit.new_string).count === 1
        ) {
          passedEditNumbers.push(i + 1);
          continue;
        }
        updated = replaceAll
          ? updated.replaceAll(edit.old_string, edit.new_string)
          : `${updated.slice(0, firstIndex)}${edit.new_string}${updated.slice(firstIndex + edit.old_string.length)}`;
        totalReplacements += replaceAll ? occurrences : 1;
        passedEditNumbers.push(i + 1);
      }

      if (failures.length > 0) {
        const passedLabels = passedEditNumbers.map((n) => `#${n}`).join(", ");
        const batchSummary =
          passedEditNumbers.length > 0
            ? `\n\n[Resumo do lote: edicoes ${passedLabels} validadas OK — corrija apenas a(s) edicao(oes) com falha acima]`
            : "";
        throw new Error(`${failures.join("\n\n")}${batchSummary}`);
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
      "Lista arquivos e subdiretorios com paginacao, filtro opcional pattern (substring/glob com '|') e profundidade opcional (max_depth de 1 a 4). " +
      "Em max_depth > 1, ignora automaticamente node_modules, .git, .next, dist, build e coverage. " +
      "DICA: use pattern (ex.: pattern='*inbox*|*media*' ou pattern='crm-api') para filtrar diretorios grandes como /root/repos/work instantaneamente; para localizar arquivos em toda a arvore, prefira find_files.",
    schema: {
      path: z.string().optional().describe("Diretorio a listar. Padrao: diretorio home."),
      pattern: z
        .string()
        .optional()
        .describe(
          "Filtro opcional por nome/caminho das entradas (case-insensitive). Aceita substring ou glob e alternancia com '|' (ex.: 'crm-api', '*inbox*|*media*').",
        ),
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
      const { target, extractedGlob } = resolveTargetAndTrailingGlob(args.path as string | undefined);
      const explicitPattern = (args.pattern as string | undefined)?.trim();
      const rawPattern = explicitPattern || extractedGlob;
      const patternTerms = rawPattern ? splitPatternAlternation(rawPattern) : [];
      const inferredDepth =
        extractedGlob && extractedGlob.includes("/")
          ? Math.min(4, Math.max(1, extractedGlob.split("/").filter((s) => s && s !== "**").length))
          : 1;
      const maxDepth = (args.max_depth as number | undefined) ?? inferredDepth;
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
        // Em /root/repos/work (milhares de worktrees), quando max_depth > 1 e pattern e informado no nivel 1,
        // evita entrar recursivamente em worktrees cujo nome nao casa com pattern se ja houver worktrees casando.
        const pruneTopLevelWorktrees =
          depth === 1 &&
          maxDepth > 1 &&
          patternTerms.length > 0 &&
          target === "/root/repos/work" &&
          dirents.some((d) => d.isDirectory() && patternTerms.some((term) => matchesFindTerm(d.name, term, false)));

        for (const e of dirents) {
          if (collected.length >= maxCollect) break;
          if (maxDepth > 1 && e.isDirectory()) {
            if (DEFAULT_SEARCH_IGNORE_DIRS.includes(e.name)) continue;
            if (e.name === "work" && currentDir === "/root/repos") continue;
          }
          const relPath = prefix ? `${prefix}/${e.name}` : e.name;
          const kind: DirItem["kind"] = e.isDirectory() ? "dir " : e.isSymbolicLink() ? "link" : "file";
          const matchesEntry =
            patternTerms.length === 0 ||
            patternTerms.some((term) => matchesFindTerm(relPath, term, false));
          if (matchesEntry) {
            collected.push({ kind, relPath });
          }
          if (e.isDirectory() && depth < maxDepth) {
            if (pruneTopLevelWorktrees && !matchesEntry) {
              continue;
            }
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
        rawPattern ? `pattern: ${rawPattern}` : "",
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
    description: "Exclui um arquivo ou diretorio. Diretorios vazios sao removidos diretamente; para diretorios nao-vazios, use recursive=true. Operacao irreversivel.",
    schema: {
      path: z.string().describe("Caminho a excluir."),
      recursive: z.boolean().optional().describe("Excluir diretorio e todo o conteudo. Padrao: false (diretorios vazios sao removidos mesmo com recursive=false)."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      const recursive = (args.recursive as boolean | undefined) ?? false;
      if (!recursive) {
        try {
          const st = await fs.lstat(target);
          if (st.isDirectory()) {
            const entries = await fs.readdir(target);
            if (entries.length === 0) {
              await fs.rmdir(target);
              return textResult(`Excluido: ${target}.`);
            }
            throw new Error(
              `O diretorio ${target} nao esta vazio (${entries.length} entrada(s)). Passe recursive=true em delete_path para excluir o diretorio e seu conteudo.`,
            );
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            throw err;
          }
        }
      }
      await fs.rm(target, { recursive, force: false });
      return textResult(`Excluido: ${target}.`);
    },
  },
];
