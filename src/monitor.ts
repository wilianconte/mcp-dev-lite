import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { Router, type Request, type Response } from "express";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_SERVER_VERSION,
  sanitizeAuditValue,
  summarizeToolResult,
  truncateString,
  type ToolResultSummary,
} from "./audit.js";

const DEFAULT_MAX_TRANSACTIONS = 500;
const MAX_RECENT_CLOSED_SESSIONS = 50;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_HYDRATE_KPI_BYTES = 25 * 1024 * 1024;
const MAX_KPI_ENTRIES = 50_000;

const DEPLOY_TS_V143 = Date.parse("2026-10-20T09:57:00.000Z");
const DEPLOY_TS_V144 = Date.parse("2026-10-25T16:59:55.000Z");
const DEPLOY_TS_V145 = Date.parse("2026-11-06T16:32:54.000Z");

export type KpiErrorKind =
  | "multiple_occurrences"
  | "missing_old_string"
  | "enoent"
  | "invalid_job_id"
  | "sync_timeout"
  | "other";

export interface KpiCallEntry {
  timestamp: string;
  tsMs: number;
  version: string;
  tool: string;
  durationMs: number;
  isError: boolean;
  errorKind?: KpiErrorKind;
  errorMsg?: string;
  textChars: number;
  targetPath?: string;
  targetPaths?: string[];
  batchCount?: number;
  waitMs?: number;
  hasIncrementalOffset?: boolean;
  autoCorrectedJobId?: boolean;
  compactedFrames?: number;
  timedOut?: boolean;
  manualNvmPath?: boolean;
  shellAntiPattern?: boolean;
  targetSummary?: string;
}

export interface KpiSampleReadiness {
  stage: "PRONTA" | "PRELIMINAR" | "COLETA_INICIAL";
  stageLabel: string;
  overallProgressPct: number;
  calls: { current: number; target: number; preliminary: number; pct: number };
  edits: { current: number; target: number; preliminary: number; pct: number };
  polls: { current: number; target: number; preliminary: number; pct: number };
  days: { current: number; activeDays: number; target: number; minCallsForDays: number; pct: number };
}

export interface KpiToolRow {
  tool: string;
  calls: number;
  sharePct: number;
  errors: number;
  errorRatePct: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  avgChars: number;
  p95Chars: number;
}

export interface KpiWindowMetrics {
  windowKey: string;
  windowLabel: string;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  spanHours: number;
  spanDays: number;
  activeDaysCount: number;
  sampleReadiness: KpiSampleReadiness;
  reliability: {
    totalCalls: number;
    totalErrors: number;
    successRatePct: number;
    errorRatePct: number;
  };
  editing: {
    totalEdits: number;
    editFileCalls: number;
    multiEditFileCalls: number;
    editErrors: number;
    firstPassSuccessPct: number;
    recoverableErrors: number;
    selfHealedWithoutRead: number;
    recoveredWithRead: number;
    selfHealRatePct: number;
    totalRecoveryRatePct: number;
    causes: {
      multipleOccurrences: number;
      missingOldString: number;
      enoent: number;
      other: number;
    };
  };
  polling: {
    startCommandCalls: number;
    pollCommandCalls: number;
    pollErrors: number;
    pollSuccessPct: number;
    pollsPerJob: number;
    longWaitPolls: number;
    longWaitPollPct: number;
    incrementalOffsetPolls: number;
    incrementalOffsetPct: number;
    autoCorrectedJobIds: number;
    compactedWatchFrames: number;
  };
  hygiene: {
    runCommandCalls: number;
    commandCallsTotal: number;
    manualNvmCalls: number;
    manualNvmRatePct: number;
    zeroManualNvmPct: number;
    nativeReadSearchCalls: number;
    shellReadSearchAntiPatterns: number;
    nativeToolAdoptionPct: number;
    syncTimeouts: number;
    syncTimeoutRatePct: number;
  };
  batching: {
    readFileCalls: number;
    readFilesCalls: number;
    readBatchRatioPct: number;
    avgFilesPerReadBatch: number;
    editBatchRatioPct: number;
    avgEditsPerMultiEdit: number;
    avgPayloadChars: number;
    p95PayloadChars: number;
  };
  latency: {
    localToolCalls: number;
    avgLocalMs: number;
    p50LocalMs: number;
    p95LocalMs: number;
    avgGlobalMs: number;
  };
  byTool: KpiToolRow[];
  diagnostics: {
    errorBreakdown: {
      multipleOccurrences: number;
      missingOldString: number;
      enoent: number;
      invalidJobId: number;
      syncTimeout: number;
      other: number;
    };
    recentErrors: Array<{
      timestamp: string;
      tool: string;
      target: string;
      error: string;
      kind: KpiErrorKind;
    }>;
  };
}

export interface KpiComparisonReport {
  generatedAt: string;
  currentVersion: string;
  windowKey: string;
  compareKey: string;
  versionCounts: Record<string, number>;
  current: KpiWindowMetrics;
  baseline: KpiWindowMetrics | null;
}

function inferAuditVersion(rawVersion: unknown, tsMs: number): string {
  if (typeof rawVersion === "string" && rawVersion.trim()) {
    return rawVersion.trim().replace(/^v/i, "");
  }
  if (tsMs >= DEPLOY_TS_V145) return "1.4.5";
  if (tsMs >= DEPLOY_TS_V144) return "1.4.4";
  if (tsMs >= DEPLOY_TS_V143) return "1.4.3";
  return "pre-1.4.3";
}

function classifyErrorKind(tool: string, errMsg: string, timedOut: boolean): KpiErrorKind {
  if (timedOut || (/timeout/i.test(errMsg) && (tool === "run_command" || tool === "start_command"))) {
    return "sync_timeout";
  }
  if (/aparece\s+\d+\s+vezes/i.test(errMsg)) return "multiple_occurrences";
  if (/old_string\s+nao\s+encontrado/i.test(errMsg)) return "missing_old_string";
  if (/ENOENT|Caminho\s+inexistente|nao\s+existe|no\s+such\s+file/i.test(errMsg)) return "enoent";
  if (/job_id.*nao\s+encontrado|Job\s+(?:.*\s+)?nao\s+encontrado/i.test(errMsg)) return "invalid_job_id";
  return "other";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

function buildKpiEntryFromAudit(parsed: Record<string, unknown>): KpiCallEntry | null {
  const tool = typeof parsed.tool === "string" ? parsed.tool : "";
  if (!tool) return null;
  const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString();
  const tsMs = Date.parse(ts) || Date.now();
  const version = inferAuditVersion(parsed.version, tsMs);
  const durationMs = typeof parsed.duration_ms === "number" ? Math.max(0, parsed.duration_ms) : 0;
  const resultObj = (parsed.result as ToolResultSummary | undefined) ?? undefined;
  const rawError = typeof parsed.error === "string" ? parsed.error : "";
  const isError = Boolean(rawError) || Boolean(resultObj?.is_error);
  const timedOut = Boolean(resultObj?.timed_out);
  const textChars = typeof resultObj?.text_chars === "number" ? resultObj.text_chars : 0;
  const args = (parsed.args && typeof parsed.args === "object" ? parsed.args : {}) as Record<string, unknown>;

  const targetPath = typeof args.path === "string" ? args.path : undefined;
  let targetPaths: string[] | undefined;
  let batchCount: number | undefined;
  if (tool === "read_files" && Array.isArray(args.files)) {
    batchCount = args.files.length;
    targetPaths = args.files
      .map((f) => (f && typeof f === "object" && typeof (f as Record<string, unknown>).path === "string" ? String((f as Record<string, unknown>).path) : ""))
      .filter(Boolean);
  } else if (tool === "stat_path" && Array.isArray(args.paths)) {
    batchCount = args.paths.length;
    targetPaths = args.paths.map((p) => (typeof p === "string" ? p : "")).filter(Boolean);
  } else if (tool === "multi_edit_file" && Array.isArray(args.edits)) {
    batchCount = args.edits.length;
  }

  const cmd = typeof args.command === "string" ? args.command.trim() : "";
  const waitMs = typeof args.wait_ms === "number" ? args.wait_ms : undefined;
  const hasIncrementalOffset =
    tool === "poll_command" ? Number(args.offset) > 0 || Number(args.stderr_offset) > 0 : undefined;
  const autoCorrectedJobId = Boolean(resultObj?.job_id_autocorrected_from);
  const compactedFrames =
    typeof resultObj?.compacted_watch_frames === "number" ? resultObj.compacted_watch_frames : undefined;
  const manualNvmPath =
    (tool === "run_command" || tool === "start_command") && /\.nvm\/versions\/node/.test(cmd);
  const shellAntiPattern =
    tool === "run_command" &&
    /^(cat|head|tail|grep|rg|find|ls)\b/.test(cmd) &&
    !/[;&|><`$]/.test(cmd);

  let targetSummary = targetPath ?? "";
  if (!targetSummary && cmd) targetSummary = `$ ${cmd.slice(0, 90)}`;
  else if (!targetSummary && typeof args.job_id === "string") targetSummary = `job_id=${args.job_id}`;
  else if (!targetSummary && targetPaths && targetPaths.length > 0) targetSummary = `${targetPaths.length} arqs (${targetPaths[0]})`;

  const errorKind = isError ? classifyErrorKind(tool, rawError, timedOut) : undefined;
  const errorMsg = isError ? (rawError ? rawError.split("\n")[0].slice(0, 220) : "Erro na ferramenta") : undefined;

  return {
    timestamp: ts,
    tsMs,
    version,
    tool,
    durationMs,
    isError,
    ...(errorKind ? { errorKind } : {}),
    ...(errorMsg ? { errorMsg } : {}),
    textChars,
    ...(targetPath ? { targetPath } : {}),
    ...(targetPaths ? { targetPaths } : {}),
    ...(batchCount !== undefined ? { batchCount } : {}),
    ...(waitMs !== undefined ? { waitMs } : {}),
    ...(hasIncrementalOffset !== undefined ? { hasIncrementalOffset } : {}),
    ...(autoCorrectedJobId ? { autoCorrectedJobId: true } : {}),
    ...(compactedFrames ? { compactedFrames } : {}),
    ...(timedOut ? { timedOut: true } : {}),
    ...(manualNvmPath ? { manualNvmPath: true } : {}),
    ...(shellAntiPattern ? { shellAntiPattern: true } : {}),
    ...(targetSummary ? { targetSummary } : {}),
  };
}

const LOCAL_NATIVE_TOOLS = new Set([
  "read_file",
  "read_files",
  "stat_path",
  "search_code",
  "find_files",
  "read_image",
  "write_file",
  "edit_file",
  "multi_edit_file",
  "list_directory",
  "move_file",
  "make_directory",
  "delete_path",
  "read_command_output",
]);

const NATIVE_READ_SEARCH_TOOLS = new Set([
  "read_file",
  "read_files",
  "stat_path",
  "search_code",
  "find_files",
  "list_directory",
]);

function filterKpiEntriesByWindow(entries: KpiCallEntry[], windowKey: string, nowMs = Date.now()): { list: KpiCallEntry[]; label: string } {
  const norm = (windowKey || `v${MCP_SERVER_VERSION}`).trim();
  if (norm === "v1.4.8" || norm === "1.4.8") {
    return { list: entries.filter((e) => e.version === "1.4.8"), label: "Versao v1.4.8 (Atual)" };
  }
  if (norm === "v1.4.7" || norm === "1.4.7") {
    return { list: entries.filter((e) => e.version === "1.4.7"), label: "Versao v1.4.7 (11/nov–12/nov)" };
  }
  if (norm === "v1.4.6" || norm === "1.4.6") {
    return { list: entries.filter((e) => e.version === "1.4.6"), label: "Versao v1.4.6 (08/nov–10/nov)" };
  }
  if (norm === "v1.4.5" || norm === "1.4.5") {
    return { list: entries.filter((e) => e.version === "1.4.5"), label: "Versao v1.4.5 (06/nov–08/nov)" };
  }
  if (norm === "v1.4.4" || norm === "1.4.4") {
    return { list: entries.filter((e) => e.version === "1.4.4"), label: "Versao v1.4.4 (25/out–06/nov)" };
  }
  if (norm === "v1.4.3" || norm === "1.4.3") {
    return { list: entries.filter((e) => e.version === "1.4.3"), label: "Versao v1.4.3 (20/out–25/out)" };
  }
  if (norm === "pre-1.4.3") {
    return { list: entries.filter((e) => e.version === "pre-1.4.3"), label: "Versoes pre-1.4.3" };
  }
  if (norm === "last_24h") {
    const cutoff = nowMs - 24 * 3600 * 1000;
    return { list: entries.filter((e) => e.tsMs >= cutoff), label: "Ultimas 24 horas" };
  }
  if (norm === "last_7d") {
    const cutoff = nowMs - 7 * 24 * 3600 * 1000;
    return { list: entries.filter((e) => e.tsMs >= cutoff), label: "Ultimos 7 dias" };
  }
  if (norm === "last_1500") {
    return { list: entries.slice(-1500), label: "Ultimas 1.500 chamadas" };
  }
  if (norm === "all") {
    return { list: entries, label: "Todo o historico" };
  }
  return { list: entries.filter((e) => e.version === "1.4.8"), label: "Versao v1.4.8 (Atual)" };
}

function computeKpiWindowMetrics(entries: KpiCallEntry[], windowKey: string, windowLabel: string): KpiWindowMetrics {
  const totalCalls = entries.length;
  const firstTimestamp = totalCalls > 0 ? entries[0].timestamp : null;
  const lastTimestamp = totalCalls > 0 ? entries[totalCalls - 1].timestamp : null;
  const spanMs = totalCalls > 1 ? Math.max(0, entries[totalCalls - 1].tsMs - entries[0].tsMs) : 0;
  const spanHours = round1(spanMs / (3600 * 1000));
  const spanDays = round2(spanMs / (24 * 3600 * 1000));

  const activeDaysSet = new Set<string>();
  let totalErrors = 0;

  let editFileCalls = 0;
  let multiEditFileCalls = 0;
  let editErrors = 0;
  let totalMultiEditBlocks = 0;
  const editCauses = { multipleOccurrences: 0, missingOldString: 0, enoent: 0, other: 0 };

  let startCommandCalls = 0;
  let pollCommandCalls = 0;
  let pollErrors = 0;
  let longWaitPolls = 0;
  let incrementalOffsetPolls = 0;
  let autoCorrectedJobIds = 0;
  let compactedWatchFrames = 0;

  let runCommandCalls = 0;
  let manualNvmCalls = 0;
  let nativeReadSearchCalls = 0;
  let shellReadSearchAntiPatterns = 0;
  let syncTimeouts = 0;

  let readFileCalls = 0;
  let readFilesCalls = 0;
  let totalReadBatchFiles = 0;

  let totalPayloadChars = 0;
  const payloadCharsArr: number[] = [];

  let totalGlobalMs = 0;
  let totalLocalMs = 0;
  const localDurs: number[] = [];

  const errorBreakdown = {
    multipleOccurrences: 0,
    missingOldString: 0,
    enoent: 0,
    invalidJobId: 0,
    syncTimeout: 0,
    other: 0,
  };
  const recentErrors: Array<{ timestamp: string; tool: string; target: string; error: string; kind: KpiErrorKind }> = [];

  const toolMap = new Map<
    string,
    { calls: number; errors: number; totalMs: number; durs: number[]; totalChars: number; chars: number[] }
  >();

  for (let i = 0; i < totalCalls; i += 1) {
    const e = entries[i];
    if (e.timestamp.length >= 10) activeDaysSet.add(e.timestamp.slice(0, 10));

    totalGlobalMs += e.durationMs;
    totalPayloadChars += e.textChars;
    payloadCharsArr.push(e.textChars);

    if (LOCAL_NATIVE_TOOLS.has(e.tool)) {
      totalLocalMs += e.durationMs;
      localDurs.push(e.durationMs);
    }
    if (NATIVE_READ_SEARCH_TOOLS.has(e.tool)) {
      nativeReadSearchCalls += 1;
    }

    let tm = toolMap.get(e.tool);
    if (!tm) {
      tm = { calls: 0, errors: 0, totalMs: 0, durs: [], totalChars: 0, chars: [] };
      toolMap.set(e.tool, tm);
    }
    tm.calls += 1;
    tm.totalMs += e.durationMs;
    tm.durs.push(e.durationMs);
    tm.totalChars += e.textChars;
    tm.chars.push(e.textChars);

    if (e.isError) {
      totalErrors += 1;
      tm.errors += 1;
      const kind = e.errorKind ?? "other";
      if (kind === "multiple_occurrences") errorBreakdown.multipleOccurrences += 1;
      else if (kind === "missing_old_string") errorBreakdown.missingOldString += 1;
      else if (kind === "enoent") errorBreakdown.enoent += 1;
      else if (kind === "invalid_job_id") errorBreakdown.invalidJobId += 1;
      else if (kind === "sync_timeout") errorBreakdown.syncTimeout += 1;
      else errorBreakdown.other += 1;

      recentErrors.push({
        timestamp: e.timestamp,
        tool: e.tool,
        target: e.targetSummary ?? "-",
        error: e.errorMsg ?? "Erro",
        kind,
      });
    }

    if (e.tool === "edit_file" || e.tool === "multi_edit_file") {
      if (e.tool === "edit_file") editFileCalls += 1;
      else {
        multiEditFileCalls += 1;
        totalMultiEditBlocks += e.batchCount ?? 1;
      }
      if (e.isError) {
        editErrors += 1;
        if (e.errorKind === "multiple_occurrences") editCauses.multipleOccurrences += 1;
        else if (e.errorKind === "missing_old_string") editCauses.missingOldString += 1;
        else if (e.errorKind === "enoent") editCauses.enoent += 1;
        else editCauses.other += 1;
      }
    } else if (e.tool === "read_file") {
      readFileCalls += 1;
    } else if (e.tool === "read_files") {
      readFilesCalls += 1;
      totalReadBatchFiles += e.batchCount ?? 1;
    } else if (e.tool === "start_command") {
      startCommandCalls += 1;
      if (e.manualNvmPath) manualNvmCalls += 1;
      if (e.compactedFrames) compactedWatchFrames += e.compactedFrames;
    } else if (e.tool === "poll_command") {
      pollCommandCalls += 1;
      if (e.isError) pollErrors += 1;
      if ((e.waitMs ?? 0) >= 60_000) longWaitPolls += 1;
      if (e.hasIncrementalOffset) incrementalOffsetPolls += 1;
      if (e.autoCorrectedJobId) autoCorrectedJobIds += 1;
      if (e.compactedFrames) compactedWatchFrames += e.compactedFrames;
    } else if (e.tool === "run_command") {
      runCommandCalls += 1;
      if (e.manualNvmPath) manualNvmCalls += 1;
      if (e.shellAntiPattern) shellReadSearchAntiPatterns += 1;
      if (e.timedOut || e.errorKind === "sync_timeout") syncTimeouts += 1;
    }
  }

  // Calculo de Auto-Recuperacao de Edicoes (Self-Heal sem read_file vs Recuperacao com read_file)
  let recoverableErrors = 0;
  let selfHealedWithoutRead = 0;
  let recoveredWithRead = 0;
  for (let i = 0; i < totalCalls; i += 1) {
    const e = entries[i];
    if ((e.tool === "edit_file" || e.tool === "multi_edit_file") && e.isError && e.targetPath) {
      recoverableErrors += 1;
      let usedReadOnTarget = false;
      const errParentDir = e.targetPath.includes("/") ? e.targetPath.slice(0, e.targetPath.lastIndexOf("/")) : "";
      const maxLookahead = Math.min(totalCalls - 1, i + 20);
      for (let j = i + 1; j <= maxLookahead; j += 1) {
        const next = entries[j];
        if (next.tsMs - e.tsMs > 10 * 60_000) break;
        if (next.tool === "read_file" && next.targetPath === e.targetPath) {
          usedReadOnTarget = true;
        } else if (next.tool === "read_files" && next.targetPaths?.includes(e.targetPath)) {
          usedReadOnTarget = true;
        } else if (next.tool === "edit_file" || next.tool === "multi_edit_file") {
          const sameTarget = next.targetPath === e.targetPath;
          const nextParentDir =
            next.targetPath && next.targetPath.includes("/")
              ? next.targetPath.slice(0, next.targetPath.lastIndexOf("/"))
              : "";
          const typoSiblingRecovery = e.errorKind === "enoent" && Boolean(errParentDir) && nextParentDir === errParentDir;
          if ((sameTarget || typoSiblingRecovery) && !next.isError) {
            if (!usedReadOnTarget) selfHealedWithoutRead += 1;
            else recoveredWithRead += 1;
            break;
          }
        }
      }
    }
  }

  const totalEdits = editFileCalls + multiEditFileCalls;
  const firstPassSuccessPct = totalEdits > 0 ? round2(((totalEdits - editErrors) / totalEdits) * 100) : 100;
  const selfHealRatePct = recoverableErrors > 0 ? round1((selfHealedWithoutRead / recoverableErrors) * 100) : 100;
  const totalRecoveryRatePct =
    recoverableErrors > 0 ? round1(((selfHealedWithoutRead + recoveredWithRead) / recoverableErrors) * 100) : 100;

  const pollSuccessPct =
    pollCommandCalls > 0 ? round2(((pollCommandCalls - pollErrors) / pollCommandCalls) * 100) : 100;
  const pollsPerJob = startCommandCalls > 0 ? round2(pollCommandCalls / startCommandCalls) : 0;
  const longWaitPollPct = pollCommandCalls > 0 ? round1((longWaitPolls / pollCommandCalls) * 100) : 100;
  const incrementalOffsetPct = pollCommandCalls > 0 ? round1((incrementalOffsetPolls / pollCommandCalls) * 100) : 0;

  const commandCallsTotal = runCommandCalls + startCommandCalls;
  const manualNvmRatePct = commandCallsTotal > 0 ? round2((manualNvmCalls / commandCallsTotal) * 100) : 0;
  const zeroManualNvmPct = round2(100 - manualNvmRatePct);
  const totalReadSearchOps = nativeReadSearchCalls + shellReadSearchAntiPatterns;
  const nativeToolAdoptionPct =
    totalReadSearchOps > 0 ? round2((nativeReadSearchCalls / totalReadSearchOps) * 100) : 100;
  const syncTimeoutRatePct = runCommandCalls > 0 ? round2((syncTimeouts / runCommandCalls) * 100) : 0;

  const totalReadOps = readFileCalls + readFilesCalls;
  const readBatchRatioPct = totalReadOps > 0 ? round1((readFilesCalls / totalReadOps) * 100) : 0;
  const avgFilesPerReadBatch = readFilesCalls > 0 ? round1(totalReadBatchFiles / readFilesCalls) : 0;
  const editBatchRatioPct = totalEdits > 0 ? round1((multiEditFileCalls / totalEdits) * 100) : 0;
  const avgEditsPerMultiEdit = multiEditFileCalls > 0 ? round1(totalMultiEditBlocks / multiEditFileCalls) : 0;

  payloadCharsArr.sort((a, b) => a - b);
  localDurs.sort((a, b) => a - b);

  const CALLS_TARGET = 1500;
  const CALLS_PRELIM = 500;
  const EDITS_TARGET = 200;
  const EDITS_PRELIM = 75;
  const POLLS_TARGET = 80;
  const POLLS_PRELIM = 30;
  const DAYS_TARGET = 7;
  const MIN_CALLS_DAYS = 1000;

  const callsPct = Math.min(100, round1((totalCalls / CALLS_TARGET) * 100));
  const editsPct = Math.min(100, round1((totalEdits / EDITS_TARGET) * 100));
  const pollsPct = Math.min(100, round1((pollCommandCalls / POLLS_TARGET) * 100));
  const daysPct = Math.min(
    100,
    round1((Math.min(1, spanDays / DAYS_TARGET) * 0.6 + Math.min(1, totalCalls / MIN_CALLS_DAYS) * 0.4) * 100),
  );
  const volumeWeightedPct = round1(
    (Math.min(1, totalCalls / CALLS_TARGET) * 0.5 +
      Math.min(1, totalEdits / EDITS_TARGET) * 0.3 +
      Math.min(1, pollCommandCalls / POLLS_TARGET) * 0.2) *
      100,
  );

  const isVolumeReady = totalCalls >= CALLS_TARGET && totalEdits >= EDITS_TARGET && pollCommandCalls >= POLLS_TARGET;
  const isTimeHybridReady = spanDays >= DAYS_TARGET && totalCalls >= MIN_CALLS_DAYS;
  const isPreliminary = totalCalls >= CALLS_PRELIM && totalEdits >= EDITS_PRELIM && pollCommandCalls >= POLLS_PRELIM;

  const stage: KpiSampleReadiness["stage"] =
    isVolumeReady || isTimeHybridReady ? "PRONTA" : isPreliminary ? "PRELIMINAR" : "COLETA_INICIAL";
  const stageLabel =
    stage === "PRONTA"
      ? "Massa Critica Atingida — Pronta para Reavaliacao"
      : stage === "PRELIMINAR"
        ? "Amostra Preliminar — Tendencias Iniciais Validadas"
        : "Coleta Inicial em Andamento — Aguardando Massa Critica";
  const overallProgressPct = stage === "PRONTA" ? 100 : Math.min(99, Math.max(volumeWeightedPct, daysPct));

  const byTool: KpiToolRow[] = Array.from(toolMap.entries())
    .map(([tool, st]) => {
      st.durs.sort((a, b) => a - b);
      st.chars.sort((a, b) => a - b);
      return {
        tool,
        calls: st.calls,
        sharePct: totalCalls > 0 ? round1((st.calls / totalCalls) * 100) : 0,
        errors: st.errors,
        errorRatePct: st.calls > 0 ? round2((st.errors / st.calls) * 100) : 0,
        avgMs: st.calls > 0 ? Math.round(st.totalMs / st.calls) : 0,
        p50Ms: percentile(st.durs, 0.5),
        p95Ms: percentile(st.durs, 0.95),
        avgChars: st.calls > 0 ? Math.round(st.totalChars / st.calls) : 0,
        p95Chars: percentile(st.chars, 0.95),
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const errorRatePct = totalCalls > 0 ? round2((totalErrors / totalCalls) * 100) : 0;
  const successRatePct = round2(100 - errorRatePct);

  return {
    windowKey,
    windowLabel,
    firstTimestamp,
    lastTimestamp,
    spanHours,
    spanDays,
    activeDaysCount: activeDaysSet.size,
    sampleReadiness: {
      stage,
      stageLabel,
      overallProgressPct,
      calls: { current: totalCalls, target: CALLS_TARGET, preliminary: CALLS_PRELIM, pct: callsPct },
      edits: { current: totalEdits, target: EDITS_TARGET, preliminary: EDITS_PRELIM, pct: editsPct },
      polls: { current: pollCommandCalls, target: POLLS_TARGET, preliminary: POLLS_PRELIM, pct: pollsPct },
      days: {
        current: spanDays,
        activeDays: activeDaysSet.size,
        target: DAYS_TARGET,
        minCallsForDays: MIN_CALLS_DAYS,
        pct: daysPct,
      },
    },
    reliability: {
      totalCalls,
      totalErrors,
      successRatePct,
      errorRatePct,
    },
    editing: {
      totalEdits,
      editFileCalls,
      multiEditFileCalls,
      editErrors,
      firstPassSuccessPct,
      recoverableErrors,
      selfHealedWithoutRead,
      recoveredWithRead,
      selfHealRatePct,
      totalRecoveryRatePct,
      causes: editCauses,
    },
    polling: {
      startCommandCalls,
      pollCommandCalls,
      pollErrors,
      pollSuccessPct,
      pollsPerJob,
      longWaitPolls,
      longWaitPollPct,
      incrementalOffsetPolls,
      incrementalOffsetPct,
      autoCorrectedJobIds,
      compactedWatchFrames,
    },
    hygiene: {
      runCommandCalls,
      commandCallsTotal,
      manualNvmCalls,
      manualNvmRatePct,
      zeroManualNvmPct,
      nativeReadSearchCalls,
      shellReadSearchAntiPatterns,
      nativeToolAdoptionPct,
      syncTimeouts,
      syncTimeoutRatePct,
    },
    batching: {
      readFileCalls,
      readFilesCalls,
      readBatchRatioPct,
      avgFilesPerReadBatch,
      editBatchRatioPct,
      avgEditsPerMultiEdit,
      avgPayloadChars: totalCalls > 0 ? Math.round(totalPayloadChars / totalCalls) : 0,
      p95PayloadChars: percentile(payloadCharsArr, 0.95),
    },
    latency: {
      localToolCalls: localDurs.length,
      avgLocalMs: localDurs.length > 0 ? Math.round(totalLocalMs / localDurs.length) : 0,
      p50LocalMs: percentile(localDurs, 0.5),
      p95LocalMs: percentile(localDurs, 0.95),
      avgGlobalMs: totalCalls > 0 ? Math.round(totalGlobalMs / totalCalls) : 0,
    },
    byTool,
    diagnostics: {
      errorBreakdown,
      recentErrors: recentErrors.slice(-10).reverse(),
    },
  };
}

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
  kpis?: KpiComparisonReport;
}

export class McpMonitor {
  private readonly startedAtMs = Date.now();
  private readonly maxTransactions: number;
  private readonly activeSessions = new Map<string, SessionSnapshot>();
  private readonly closedSessions: SessionSnapshot[] = [];
  private readonly transactions: TransactionRecord[] = [];
  private readonly transactionsById = new Map<string, TransactionRecord>();
  private readonly kpiEntries: KpiCallEntry[] = [];
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

  private pushKpiEntry(entry: KpiCallEntry): void {
    this.kpiEntries.push(entry);
    while (this.kpiEntries.length > MAX_KPI_ENTRIES) {
      this.kpiEntries.shift();
    }
  }

  private async readAuditLinesFromFile(targetPath: string): Promise<string[]> {
    try {
      const handle = await open(targetPath, "r");
      let content = "";
      try {
        const st = await handle.stat();
        if (st.size <= 0) return [];
        const readLen = Math.min(st.size, MAX_HYDRATE_KPI_BYTES);
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
      return content.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Carrega registros do arquivo JSONL de auditoria para popular o motor de KPIs e o historico de transacoes recentes. */
  async hydrateFromAuditFile(filePath: string | null): Promise<void> {
    if (!filePath) return;
    try {
      const rotatedLines = await this.readAuditLinesFromFile(`${filePath}.1`);
      const currentLines = await this.readAuditLinesFromFile(filePath);
      const allLines = rotatedLines.length > 0 ? [...rotatedLines, ...currentLines] : currentLines;
      if (allLines.length === 0) return;

      const recentStartIndex = Math.max(0, allLines.length - this.maxTransactions);
      for (let i = 0; i < allLines.length; i += 1) {
        const line = allLines[i];
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const kpiEntry = buildKpiEntryFromAudit(parsed);
          if (kpiEntry) {
            this.pushKpiEntry(kpiEntry);
          }

          if (i >= recentStartIndex) {
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
          }
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

    if (record.tool) {
      const kpiEntry = buildKpiEntryFromAudit({
        timestamp: record.timestamp,
        version: MCP_SERVER_VERSION,
        tool: record.tool,
        duration_ms: record.durationMs,
        args: record.args,
        result: record.result,
        error: record.error,
      });
      if (kpiEntry) {
        this.pushKpiEntry(kpiEntry);
      }
    }

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

  getKpiReport(windowKey = "v1.4.8", compareKey = "v1.4.7"): KpiComparisonReport {
    const nowMs = Date.now();
    const versionCounts: Record<string, number> = {
      "1.4.8": 0,
      "1.4.7": 0,
      "1.4.6": 0,
      "1.4.5": 0,
      "1.4.4": 0,
      "1.4.3": 0,
      "pre-1.4.3": 0,
    };
    for (const e of this.kpiEntries) {
      versionCounts[e.version] = (versionCounts[e.version] ?? 0) + 1;
    }

    const currentFiltered = filterKpiEntriesByWindow(this.kpiEntries, windowKey, nowMs);
    const currentMetrics = computeKpiWindowMetrics(currentFiltered.list, windowKey, currentFiltered.label);

    let baselineMetrics: KpiWindowMetrics | null = null;
    if (compareKey && compareKey !== "none" && compareKey !== windowKey) {
      const baseFiltered = filterKpiEntriesByWindow(this.kpiEntries, compareKey, nowMs);
      baselineMetrics = computeKpiWindowMetrics(baseFiltered.list, compareKey, baseFiltered.label);
    }

    return {
      generatedAt: new Date(nowMs).toISOString(),
      currentVersion: MCP_SERVER_VERSION,
      windowKey,
      compareKey,
      versionCounts,
      current: currentMetrics,
      baseline: baselineMetrics,
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
        version: MCP_SERVER_VERSION,
        startedAt: new Date(this.startedAtMs).toISOString(),
        uptimeSec: Math.floor((Date.now() - this.startedAtMs) / 1000),
      },
      stats: this.getStats(),
      sessions,
      // Mais recentes primeiro na listagem inicial.
      transactions: [...this.transactions].reverse(),
      kpis: this.getKpiReport("v1.4.8", "v1.4.7"),
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

    router.get("/logs/kpis", (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      const windowKey = typeof req.query.window === "string" ? req.query.window : "v1.4.8";
      const compareKey = typeof req.query.compare === "string" ? req.query.compare : "v1.4.7";
      res.json(this.getKpiReport(windowKey, compareKey));
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
  @keyframes alertPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.45); }
    50% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
  }
  .badge.alert-ringing {
    background: rgba(239, 68, 68, 0.25);
    color: #fecaca;
    border: 1px solid rgba(239, 68, 68, 0.65);
    animation: alertPulse 1.2s infinite;
  }
  .btn-danger-pulse {
    background: rgba(239, 68, 68, 0.22);
    border-color: var(--err);
    color: #fecaca;
    font-weight: 600;
    animation: alertPulse 1.2s infinite;
  }
  .btn-danger-pulse:hover {
    background: rgba(239, 68, 68, 0.35);
    border-color: #f87171;
  }
  .btn-primary {
    background: rgba(56, 189, 248, 0.16);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .btn-primary:hover {
    background: rgba(56, 189, 248, 0.26);
  }
  .global-alert-banner {
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 12px 16px;
    border-radius: 10px;
    background: linear-gradient(90deg, rgba(239, 68, 68, 0.22), rgba(245, 158, 11, 0.14));
    border: 1px solid rgba(239, 68, 68, 0.6);
    color: #fef2f2;
    animation: alertPulse 1.5s infinite;
  }
  .global-alert-banner.visible {
    display: flex;
  }
  .alerts-layout {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 16px;
  }
  .alert-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .alert-card.ringing {
    border-color: rgba(239, 68, 68, 0.7);
    background: linear-gradient(180deg, rgba(239, 68, 68, 0.08), var(--panel));
  }
  .alert-card-title {
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .wd-timer-box {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .wd-timer-value {
    font-family: var(--font-mono);
    font-size: 28px;
    font-weight: 700;
    letter-spacing: 0.5px;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .wd-timer-sub {
    font-size: 13px;
    font-weight: 400;
    color: var(--muted);
  }
  .wd-progress-track {
    width: 100%;
    height: 8px;
    background: #1e293b;
    border-radius: 999px;
    overflow: hidden;
  }
  .wd-progress-fill {
    height: 100%;
    width: 0%;
    background: var(--ok);
    border-radius: 999px;
    transition: width 0.2s linear, background-color 0.2s ease;
  }
  .wd-meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    font-size: 12px;
  }
  .wd-meta-item {
    background: rgba(11, 15, 23, 0.55);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
  }
  .wd-meta-label {
    color: var(--muted);
    margin-bottom: 3px;
  }
  .wd-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .cfg-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cfg-label {
    font-size: 12px;
    color: var(--muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .preset-group {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .preset-btn.active {
    background: rgba(56, 189, 248, 0.18);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .cfg-inline {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .cfg-inline input[type="number"] {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
    font-family: var(--font-mono);
    width: 76px;
  }
  .cfg-check {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
    line-height: 1.35;
  }
  .cfg-check input[type="checkbox"] {
    margin-top: 2px;
  }
  .kpi-readiness-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .kpi-pillars-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
  }
  .kpi-pillar {
    background: rgba(11, 15, 23, 0.55);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .kpi-scorecards-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 14px;
  }
  .kpi-scorecard {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 15px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .kpi-scorecard-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .kpi-scorecard-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .kpi-scorecard-main {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .kpi-scorecard-val {
    font-size: 26px;
    font-weight: 700;
    font-family: var(--font-mono);
  }
  .kpi-sub-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  .kpi-sub-row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    color: var(--muted);
  }
  .kpi-sub-row strong {
    color: var(--text);
    font-family: var(--font-mono);
  }
  .kpi-diag-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
    gap: 14px;
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
    <span id="idle-header-pill" class="badge neutral mono" style="display:none;cursor:pointer;" title="Watchdog de inatividade (clique para abrir a aba Alertas)">ocioso: 00m 00s</span>
    <button id="btn-header-mute" type="button" class="btn-danger-pulse" style="display:none;">Silenciar Alerta</button>
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

  <div id="global-alert-banner" class="global-alert-banner" role="alert">
    <div>
      <strong id="global-alert-title">Alerta de Inatividade no MCP!</strong>
      <div id="global-alert-desc" class="mono" style="font-size:12px;margin-top:2px;color:#fecaca;">Sem movimentacao acima do tempo configurado.</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      <button id="btn-banner-mute" type="button" class="btn-danger-pulse">Silenciar Alarme</button>
      <button id="btn-banner-reset" type="button">Zerar Cronometro</button>
      <button id="btn-banner-open-tab" type="button">Ver Aba Alertas</button>
    </div>
  </div>

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
      <button id="tab-btn-alerts" class="tab-btn" type="button" role="tab" aria-selected="false" aria-controls="tab-panel-alerts" data-tab="alerts">
        <span>Alertas</span>
        <span id="alert-tab-badge" class="badge neutral">OFF</span>
      </button>
      <button id="tab-btn-kpis" class="tab-btn" type="button" role="tab" aria-selected="false" aria-controls="tab-panel-kpis" data-tab="kpis">
        <span>KPI's</span>
        <span id="kpi-tab-badge" class="badge neutral">--</span>
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

  <!-- SECAO 3 (ABA ALERTAS): WATCHDOG DE INATIVIDADE + CONFIGURACAO SONORA + HISTORICO -->
  <section id="tab-panel-alerts" class="tab-panel" role="tabpanel" aria-labelledby="tab-btn-alerts">
    <div class="alerts-layout">
      <div id="wd-status-card" class="alert-card">
        <div class="alert-card-title">
          <span>Status do Watchdog de Inatividade</span>
          <span id="wd-state-badge" class="badge neutral">DESATIVADO</span>
        </div>

        <div class="wd-timer-box">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;">
            <span class="muted" style="font-size:12px;">Tempo sem movimentacao no MCP</span>
            <span id="wd-Audio-status" class="muted mono" style="font-size:11px;">Audio: pronto ao interagir</span>
          </div>
          <div class="wd-timer-value">
            <span id="wd-idle-timer">00m 00s</span>
            <span id="wd-idle-limit" class="wd-timer-sub">/ limite 05m 00s</span>
          </div>
          <div class="wd-progress-track">
            <div id="wd-progress-bar" class="wd-progress-fill"></div>
          </div>
        </div>

        <div class="wd-meta-grid">
          <div class="wd-meta-item">
            <div class="wd-meta-label">Ultima atividade MCP</div>
            <div id="wd-last-time" class="mono">--</div>
            <div id="wd-last-tool" class="mono muted" style="margin-top:2px;font-size:11px;">Aguardando eventos...</div>
          </div>
          <div class="wd-meta-item">
            <div class="wd-meta-label">Resumo da ultima chamada</div>
            <div id="wd-last-summary" class="mono truncate" style="max-width:100%;">--</div>
            <div id="wd-inflight-info" class="mono muted" style="margin-top:2px;font-size:11px;">Em execucao agora: 0</div>
          </div>
        </div>

        <div class="wd-actions">
          <button id="btn-wd-toggle" type="button" class="btn-primary">Ativar Alerta</button>
          <button id="btn-wd-mute" type="button" class="btn-danger-pulse" style="display:none;">Silenciar Alarme Atual</button>
          <button id="btn-wd-reset" type="button">Zerar Cronometro</button>
          <button id="btn-wd-test-sound" type="button">Testar Som</button>
        </div>
      </div>

      <div class="alert-card">
        <div class="alert-card-title">
          <span>Configuracao do Alerta Sonoro e Regras</span>
          <span class="muted" style="font-size:11px;font-weight:400;">Salvo automaticamente no navegador</span>
        </div>

        <div class="cfg-row">
          <label class="cfg-check" style="font-weight:600;">
            <input type="checkbox" id="cfg-alert-enabled" />
            <span>Monitorar inatividade do MCP e emitir alerta sonoro</span>
          </label>
        </div>

        <div class="cfg-row">
          <div class="cfg-label">Tempo limite sem movimentacao (Presets rapidos)</div>
          <div class="preset-group">
            <button type="button" class="preset-btn" data-preset-sec="60">1 min</button>
            <button type="button" class="preset-btn" data-preset-sec="180">3 min</button>
            <button type="button" class="preset-btn" data-preset-sec="300">5 min</button>
            <button type="button" class="preset-btn" data-preset-sec="600">10 min</button>
            <button type="button" class="preset-btn" data-preset-sec="900">15 min</button>
          </div>
          <div class="cfg-inline" style="margin-top:4px;">
            <span class="muted" style="font-size:12px;">Personalizado:</span>
            <input type="number" id="cfg-timeout-min" min="0" max="240" value="5" aria-label="Minutos" />
            <span class="muted" style="font-size:12px;">min</span>
            <input type="number" id="cfg-timeout-sec" min="0" max="59" value="0" aria-label="Segundos" />
            <span class="muted" style="font-size:12px;">seg</span>
          </div>
        </div>

        <div class="cfg-row">
          <div class="cfg-label">Regra de Atividade</div>
          <select id="cfg-alert-scope">
            <option value="tool_call">Apenas chamadas de ferramentas (tool_call) — Recomendado</option>
            <option value="all">Qualquer evento no MCP (tool_call, protocolo, sessao)</option>
          </select>
          <label class="cfg-check" style="margin-top:4px;">
            <input type="checkbox" id="cfg-pause-inflight" checked />
            <span>Pausar cronometro enquanto houver comando <code class="mono">Em Execucao Agora &gt; 0</code> (evita falso positivo durante <code class="mono">poll_command</code> ou builds longos)</span>
          </label>
        </div>

        <div class="cfg-row">
          <div class="cfg-label">Som do Alerta (Web Audio API)</div>
          <div class="cfg-inline">
            <select id="cfg-sound-type" style="flex:1;min-width:190px;">
              <option value="double_beep">Bipe Duplo (880Hz + 1046Hz)</option>
              <option value="urgent_alarm">Alarme Urgente (3 toques rapidos)</option>
              <option value="chime">Sino Harmonico (Acorde suave)</option>
            </select>
            <select id="cfg-repeat-sec" style="min-width:175px;">
              <option value="0">Tocar apenas 1 vez</option>
              <option value="15">Repetir a cada 15s</option>
              <option value="30" selected>Repetir a cada 30s</option>
              <option value="60">Repetir a cada 60s</option>
            </select>
          </div>
          <div class="cfg-inline" style="margin-top:4px;">
            <span class="muted" style="font-size:12px;">Volume:</span>
            <input type="range" id="cfg-volume" min="10" max="100" step="5" value="80" style="flex:1;accent-color:var(--accent);" />
            <span id="cfg-volume-label" class="mono" style="font-size:12px;min-width:38px;text-align:right;">80%</span>
          </div>
          <label class="cfg-check" style="margin-top:4px;">
            <input type="checkbox" id="cfg-desktop-notify" />
            <span>Disparar tambem notificacao nativa do navegador (Desktop Notification) <span id="cfg-notify-perm" class="muted mono" style="font-size:11px;"></span></span>
          </label>
        </div>
      </div>
    </div>

    <div class="grid-section">
      <div class="section-header">
        <div class="section-title">
          <span>Historico de Incidentes de Inatividade</span>
          <span id="alert-history-badge" class="badge neutral">0</span>
        </div>
        <button id="btn-clear-alert-history" type="button" style="font-size:12px;padding:4px 10px;">Limpar historico</button>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>Alerta Disparado em</th>
              <th>Inicio da Ociosidade</th>
              <th>Status</th>
              <th>Ultima Ferramenta / Evento</th>
              <th>Resumo da Ultima Chamada</th>
              <th>Retomou em</th>
              <th>Tempo Total Parado</th>
            </tr>
          </thead>
          <tbody id="alerts-history-tbody">
            <tr><td colspan="7" class="empty">Nenhum incidente de inatividade registrado nesta sessao.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- SECAO 4 (ABA KPI'S): MATURIDADE DA AMOSTRA + SCORECARDS QUALITATIVOS + COMPARATIVO POR TOOL + DIAGNOSTICO -->
  <section id="tab-panel-kpis" class="tab-panel" role="tabpanel" aria-labelledby="tab-btn-kpis">
    <div class="filter-card">
      <div class="filter-controls">
        <label class="muted" style="font-size:12px;font-weight:600;text-transform:uppercase;">Janela / Versao:</label>
        <select id="kpi-window-select">
          <option value="v1.4.8" selected>Versao Atual (v1.4.8)</option>
          <option value="v1.4.7">Versao v1.4.7 (11/nov–12/nov)</option>
          <option value="v1.4.6">Versao v1.4.6 (08/nov–10/nov)</option>
          <option value="v1.4.5">Versao v1.4.5 (06/nov–08/nov)</option>
          <option value="v1.4.4">Versao v1.4.4 (25/out–06/nov)</option>
          <option value="v1.4.3">Versao v1.4.3 (20/out–25/out)</option>
          <option value="last_24h">Ultimas 24 horas</option>
          <option value="last_7d">Ultimos 7 dias</option>
          <option value="last_1500">Ultimas 1.500 chamadas</option>
          <option value="all">Todo o historico</option>
        </select>

        <label class="muted" style="font-size:12px;font-weight:600;text-transform:uppercase;margin-left:8px;">Comparar com:</label>
        <select id="kpi-compare-select">
          <option value="v1.4.7" selected>Baseline v1.4.7</option>
          <option value="v1.4.6">Baseline v1.4.6</option>
          <option value="v1.4.5">Baseline v1.4.5</option>
          <option value="v1.4.4">Baseline v1.4.4</option>
          <option value="v1.4.3">Baseline v1.4.3</option>
          <option value="all">Media Historica (Tudo)</option>
          <option value="none">Sem comparacao</option>
        </select>

        <button id="btn-kpi-refresh" type="button" class="btn-primary">Atualizar KPI's</button>
      </div>
      <div id="kpi-version-counts" class="mono muted" style="font-size:12px;">Carregando historico...</div>
    </div>

    <div class="kpi-readiness-card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <div>
          <div style="font-weight:700;font-size:14.5px;display:flex;align-items:center;gap:8px;">
            <span>Termometro de Massa Critica para Reavaliacao</span>
            <span id="kpi-readiness-badge" class="badge neutral">COLETANDO</span>
          </div>
          <div id="kpi-window-range" class="muted mono" style="font-size:12px;margin-top:2px;">Janela: --</div>
        </div>
        <div class="mono" style="font-size:13px;">
          Progresso para reavaliacao: <strong id="kpi-readiness-pct">0%</strong>
        </div>
      </div>

      <div class="wd-progress-track" style="height:10px;">
        <div id="kpi-readiness-bar" class="wd-progress-fill" style="width:0%;"></div>
      </div>

      <div class="kpi-pillars-grid" id="kpi-pillars-grid"></div>
    </div>

    <div class="kpi-scorecards-grid" id="kpi-qual-grid"></div>

    <div class="grid-section">
      <div class="section-header">
        <div class="section-title">
          <span>Desempenho Qualitativo e Quantitativo por Ferramenta</span>
          <span id="kpi-tools-count-badge" class="badge neutral">0</span>
        </div>
        <span class="muted" style="font-size:12px;">Comparativo de volume, taxa de erro, latencia p50/p95 e pegada de contexto (chars)</span>
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>Ferramenta</th>
              <th>Volume (Calls / %)</th>
              <th>Erros / Taxa Atual</th>
              <th>Baseline / Variacao (Δ)</th>
              <th>Latencia (Media / p50 / p95)</th>
              <th>Payload (Media / p95 chars)</th>
              <th>Status da Meta</th>
            </tr>
          </thead>
          <tbody id="kpi-tools-tbody">
            <tr><td colspan="7" class="empty">Carregando metricas por ferramenta...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="kpi-diag-grid">
      <div class="grid-section">
        <div class="section-header">
          <div class="section-title">
            <span>Diagnostico de Falhas e Anti-Padroes (Atual vs Baseline)</span>
          </div>
        </div>
        <div style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th>Indicador / Assinatura</th>
                <th>Janela Atual</th>
                <th>Baseline</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="kpi-diag-breakdown-tbody">
              <tr><td colspan="4" class="empty">Sem dados.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="grid-section">
        <div class="section-header">
          <div class="section-title">
            <span>Ultimos Erros Registrados na Janela</span>
          </div>
        </div>
        <div style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th>Horario</th>
                <th>Ferramenta</th>
                <th>Alvo / Comando</th>
                <th>Detalhe do Erro</th>
              </tr>
            </thead>
            <tbody id="kpi-recent-errors-tbody">
              <tr><td colspan="4" class="empty">Nenhum erro registrado nesta janela.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</main>

<script>
(() => {
  const ALERT_STORAGE_KEY = 'mcp_monitor_alert_cfg_v1';
  const BASE_DOC_TITLE = document.title;

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
    kpiReport: null,
    lastKpiFetchMs: 0,
  };

  const defaultAlertCfg = {
    enabled: false,
    timeoutSec: 300,
    scope: 'tool_call',
    pauseWhenInFlight: true,
    soundType: 'double_beep',
    repeatSec: 30,
    volume: 80,
    desktopNotify: false,
  };

  function loadAlertCfg() {
    try {
      const raw = localStorage.getItem(ALERT_STORAGE_KEY);
      if (!raw) return { ...defaultAlertCfg };
      const parsed = JSON.parse(raw);
      const timeoutSec = Math.max(5, Math.min(86400, Number(parsed.timeoutSec) || 300));
      return {
        enabled: Boolean(parsed.enabled),
        timeoutSec,
        scope: parsed.scope === 'all' ? 'all' : 'tool_call',
        pauseWhenInFlight: parsed.pauseWhenInFlight !== undefined ? Boolean(parsed.pauseWhenInFlight) : true,
        soundType: ['double_beep', 'urgent_alarm', 'chime'].includes(parsed.soundType) ? parsed.soundType : 'double_beep',
        repeatSec: [0, 15, 30, 60].includes(Number(parsed.repeatSec)) ? Number(parsed.repeatSec) : 30,
        volume: Math.max(10, Math.min(100, Number(parsed.volume) || 80)),
        desktopNotify: Boolean(parsed.desktopNotify),
      };
    } catch {
      return { ...defaultAlertCfg };
    }
  }

  const alertCfg = loadAlertCfg();

  const watchdog = {
    lastTxTimeMs: Date.now(),
    lastTxIso: null,
    lastTool: '-',
    lastSummary: 'Aguardando movimentacao no MCP',
    resetAtMs: 0,
    ringing: false,
    mutedForCycle: false,
    lastBeepAtMs: 0,
    activeIncident: null,
    history: [],
    audioCtx: null,
    audioUnlocked: false,
  };

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  function switchTab(tabName) {
    const valid = tabName === 'sessions' || tabName === 'alerts' || tabName === 'kpis' ? tabName : 'transactions';
    state.activeTab = valid;
    const tabs = [
      { key: 'transactions', btn: 'tab-btn-transactions', panel: 'tab-panel-transactions', hash: '#transacoes' },
      { key: 'sessions', btn: 'tab-btn-sessions', panel: 'tab-panel-sessions', hash: '#conexoes' },
      { key: 'alerts', btn: 'tab-btn-alerts', panel: 'tab-panel-alerts', hash: '#alertas' },
      { key: 'kpis', btn: 'tab-btn-kpis', panel: 'tab-panel-kpis', hash: '#kpis' },
    ];
    for (const t of tabs) {
      const active = state.activeTab === t.key;
      el(t.btn).classList.toggle('active', active);
      el(t.btn).setAttribute('aria-selected', String(active));
      el(t.panel).classList.toggle('active', active);
      if (active && history.replaceState) {
        history.replaceState(null, '', t.hash);
      }
    }
    if (valid === 'kpis') {
      fetchKpis();
    }
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });

  if (location.hash === '#conexoes' || location.hash === '#sessions') {
    switchTab('sessions');
  } else if (location.hash === '#alertas' || location.hash === '#alerts') {
    switchTab('alerts');
  } else if (location.hash === '#kpis' || location.hash === '#kpi') {
    switchTab('kpis');
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

  function fmtMmSs(totalSec) {
    const sec = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return String(h).padStart(2, '0') + 'h ' + String(m).padStart(2, '0') + 'm ' + String(s).padStart(2, '0') + 's';
    }
    return String(m).padStart(2, '0') + 'm ' + String(s).padStart(2, '0') + 's';
  }

  function fmtShortLimit(totalSec) {
    if (totalSec % 60 === 0) return (totalSec / 60) + 'm';
    if (totalSec < 60) return totalSec + 's';
    return Math.floor(totalSec / 60) + 'm' + (totalSec % 60) + 's';
  }

  function ensureAudioContext() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!watchdog.audioCtx) {
        watchdog.audioCtx = new Ctx();
      }
      if (watchdog.audioCtx.state === 'suspended') {
        watchdog.audioCtx.resume().catch(() => {});
      }
      watchdog.audioUnlocked = watchdog.audioCtx.state === 'running';
      const statusEl = el('wd-Audio-status');
      if (statusEl) {
        statusEl.textContent = watchdog.audioUnlocked ? 'Audio: ativo (Web Audio API)' : 'Audio: pronto ao interagir';
      }
      return watchdog.audioCtx;
    } catch {
      return null;
    }
  }

  document.addEventListener('pointerdown', () => {
    ensureAudioContext();
  }, { passive: true });

  function playTone(ctx, freq, startOffset, duration, type, peakGain) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + startOffset);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + startOffset);
    gain.gain.linearRampToValueAtTime(peakGain, ctx.currentTime + startOffset + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startOffset + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime + startOffset);
    osc.stop(ctx.currentTime + startOffset + duration + 0.02);
  }

  function playAlertSound(soundType, volumePct) {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    const vol = Math.max(0.05, Math.min(1, (Number(volumePct) || 80) / 100)) * 0.35;
    if (soundType === 'urgent_alarm') {
      playTone(ctx, 960, 0.00, 0.14, 'sawtooth', vol);
      playTone(ctx, 1200, 0.16, 0.14, 'sawtooth', vol);
      playTone(ctx, 960, 0.32, 0.14, 'sawtooth', vol);
      playTone(ctx, 1200, 0.48, 0.22, 'sawtooth', vol);
    } else if (soundType === 'chime') {
      playTone(ctx, 587.33, 0.00, 0.45, 'sine', vol);
      playTone(ctx, 880.00, 0.08, 0.45, 'sine', vol * 0.85);
      playTone(ctx, 1174.66, 0.18, 0.65, 'triangle', vol * 0.9);
    } else {
      playTone(ctx, 880.00, 0.00, 0.15, 'triangle', vol);
      playTone(ctx, 1046.50, 0.20, 0.22, 'triangle', vol);
    }
  }

  function saveAlertCfg() {
    try {
      localStorage.setItem(ALERT_STORAGE_KEY, JSON.stringify(alertCfg));
    } catch {}
  }

  function updateNotifyPermLabel() {
    const permEl = el('cfg-notify-perm');
    if (!permEl) return;
    if (!('Notification' in window)) {
      permEl.textContent = '(nao suportado)';
      return;
    }
    permEl.textContent = '(permissao: ' + Notification.permission + ')';
  }

  function syncAlertConfigUi() {
    el('cfg-alert-enabled').checked = alertCfg.enabled;
    const mins = Math.floor(alertCfg.timeoutSec / 60);
    const secs = alertCfg.timeoutSec % 60;
    el('cfg-timeout-min').value = String(mins);
    el('cfg-timeout-sec').value = String(secs);
    el('cfg-alert-scope').value = alertCfg.scope;
    el('cfg-pause-inflight').checked = alertCfg.pauseWhenInFlight;
    el('cfg-sound-type').value = alertCfg.soundType;
    el('cfg-repeat-sec').value = String(alertCfg.repeatSec);
    el('cfg-volume').value = String(alertCfg.volume);
    el('cfg-volume-label').textContent = alertCfg.volume + '%';
    el('cfg-desktop-notify').checked = alertCfg.desktopNotify;

    document.querySelectorAll('.preset-btn').forEach((btn) => {
      const sec = Number(btn.getAttribute('data-preset-sec'));
      btn.classList.toggle('active', sec === alertCfg.timeoutSec);
    });

    const toggleBtn = el('btn-wd-toggle');
    toggleBtn.textContent = alertCfg.enabled ? 'Desativar Alerta' : 'Ativar Alerta';
    toggleBtn.classList.toggle('btn-primary', !alertCfg.enabled);
    el('wd-idle-limit').textContent = '/ limite ' + fmtMmSs(alertCfg.timeoutSec);
    updateNotifyPermLabel();
  }

  function renderAlertHistory() {
    el('alert-history-badge').textContent = String(watchdog.history.length);
    const tbody = el('alerts-history-tbody');
    if (watchdog.history.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">Nenhum incidente de inatividade registrado nesta sessao.</td></tr>';
      return;
    }
    const now = Date.now();
    tbody.innerHTML = watchdog.history.slice(0, 100).map((inc) => {
      const badgeClass = inc.status === 'ringing' ? 'alert-ringing' : (inc.status === 'muted' ? 'warn' : 'ok');
      const badgeLabel = inc.status === 'ringing' ? 'EM ALERTA' : (inc.status === 'muted' ? 'SILENCIADO' : 'RETOMADO');
      const totalSec = inc.resumedAtMs
        ? Math.round((inc.resumedAtMs - inc.idleSinceMs) / 1000)
        : Math.round((now - inc.idleSinceMs) / 1000);
      return '<tr>' +
        '<td class="mono">' + fmtTime(inc.triggeredAtIso) + '</td>' +
        '<td class="mono muted">' + fmtTime(inc.idleSinceIso) + '</td>' +
        '<td><span class="badge ' + badgeClass + '">' + badgeLabel + '</span></td>' +
        '<td class="mono"><strong>' + esc(inc.lastTool || '-') + '</strong></td>' +
        '<td><span class="truncate mono">' + esc(inc.lastSummary || '-') + '</span></td>' +
        '<td class="mono muted">' + (inc.resumedAtIso ? fmtTime(inc.resumedAtIso) : '(ainda parado)') + '</td>' +
        '<td class="mono">' + fmtUptime(Math.max(0, totalSec)) + '</td>' +
      '</tr>';
    }).join('');
  }

  function resolveActiveIncident(resumedIso) {
    if (watchdog.activeIncident) {
      watchdog.activeIncident.status = 'resolved';
      watchdog.activeIncident.resumedAtMs = Date.now();
      watchdog.activeIncident.resumedAtIso = resumedIso || new Date().toISOString();
      watchdog.activeIncident = null;
      renderAlertHistory();
    }
    watchdog.ringing = false;
    watchdog.mutedForCycle = false;
    document.title = BASE_DOC_TITLE;
  }

  function recordWatchdogActivity(tx, fromSnapshot) {
    if (!tx) return;
    if (alertCfg.scope === 'tool_call' && tx.category !== 'tool_call') return;
    const txTimeMs = tx.status === 'running'
      ? Date.now()
      : (tx.finishedAtMs || tx.startedAtMs || (tx.timestamp ? Date.parse(tx.timestamp) : Date.now()));
    if (!Number.isFinite(txTimeMs)) return;

    if (fromSnapshot) {
      if (txTimeMs >= watchdog.lastTxTimeMs) {
        watchdog.lastTxTimeMs = txTimeMs;
        watchdog.lastTxIso = tx.timestamp || new Date(txTimeMs).toISOString();
        watchdog.lastTool = tx.tool || tx.event || '-';
        watchdog.lastSummary = summarizeTx(tx) || tx.event || '-';
      }
      return;
    }

    watchdog.lastTxTimeMs = Date.now();
    watchdog.lastTxIso = tx.timestamp || new Date().toISOString();
    watchdog.lastTool = tx.tool || tx.event || '-';
    watchdog.lastSummary = summarizeTx(tx) || tx.event || '-';
    resolveActiveIncident(watchdog.lastTxIso);
  }

  function muteCurrentAlert() {
    ensureAudioContext();
    watchdog.ringing = false;
    watchdog.mutedForCycle = true;
    if (watchdog.activeIncident && watchdog.activeIncident.status === 'ringing') {
      watchdog.activeIncident.status = 'muted';
      renderAlertHistory();
    }
    document.title = BASE_DOC_TITLE;
    tickWatchdog();
  }

  function resetWatchdogTimer() {
    ensureAudioContext();
    watchdog.resetAtMs = Date.now();
    resolveActiveIncident(new Date().toISOString());
    tickWatchdog();
  }

  function setAlertEnabled(enabled) {
    ensureAudioContext();
    alertCfg.enabled = Boolean(enabled);
    if (alertCfg.enabled) {
      const refMs = Math.max(watchdog.lastTxTimeMs, watchdog.resetAtMs);
      if (Date.now() - refMs >= alertCfg.timeoutSec * 1000) {
        watchdog.resetAtMs = Date.now();
      }
      watchdog.mutedForCycle = false;
    } else {
      watchdog.ringing = false;
      watchdog.mutedForCycle = false;
      document.title = BASE_DOC_TITLE;
    }
    saveAlertCfg();
    syncAlertConfigUi();
    tickWatchdog();
  }

  function triggerDesktopNotification(idleSec) {
    if (!alertCfg.desktopNotify || !('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      try {
        new Notification('MCP Monitor: Inatividade detectada (' + fmtShortLimit(alertCfg.timeoutSec) + '+)', {
          body: 'Sem movimentacao ha ' + fmtMmSs(idleSec) + '. Ultima acao: ' + watchdog.lastTool,
          tag: 'mcp-inactivity-alert',
        });
      } catch {}
    }
  }

  function tickWatchdog() {
    const now = Date.now();
    const inFlight = Number(state.stats?.inFlightCalls) || 0;
    const isPausedByInFlight = alertCfg.pauseWhenInFlight && inFlight > 0;

    if (isPausedByInFlight) {
      watchdog.lastTxTimeMs = now;
      if (watchdog.ringing || watchdog.activeIncident) {
        resolveActiveIncident(new Date(now).toISOString());
      }
    }

    const effectiveLastMs = Math.max(watchdog.lastTxTimeMs, watchdog.resetAtMs);
    const idleMs = isPausedByInFlight ? 0 : Math.max(0, now - effectiveLastMs);
    const idleSec = Math.floor(idleMs / 1000);
    const limitSec = Math.max(5, alertCfg.timeoutSec);
    const ratio = Math.min(1, idleMs / (limitSec * 1000));

    el('wd-idle-timer').textContent = fmtMmSs(idleSec);
    el('wd-last-time').textContent = watchdog.lastTxIso ? fmtTime(watchdog.lastTxIso) : 'Sem chamadas registradas';
    el('wd-last-tool').textContent = 'Evento/Tool: ' + (watchdog.lastTool || '-');
    el('wd-last-summary').textContent = watchdog.lastSummary || '-';
    el('wd-inflight-info').textContent = 'Em execucao agora: ' + inFlight;

    const bar = el('wd-progress-bar');
    bar.style.width = Math.round(ratio * 100) + '%';
    if (ratio >= 1) {
      bar.style.backgroundColor = 'var(--err)';
    } else if (ratio >= 0.75) {
      bar.style.backgroundColor = 'var(--warn)';
    } else {
      bar.style.backgroundColor = 'var(--ok)';
    }

    const tabBadge = el('alert-tab-badge');
    const stateBadge = el('wd-state-badge');
    const headerPill = el('idle-header-pill');
    const headerMuteBtn = el('btn-header-mute');
    const wdMuteBtn = el('btn-wd-mute');
    const banner = el('global-alert-banner');
    const statusCard = el('wd-status-card');

    if (!alertCfg.enabled) {
      tabBadge.className = 'badge neutral';
      tabBadge.textContent = 'OFF';
      stateBadge.className = 'badge neutral';
      stateBadge.textContent = 'DESATIVADO';
      headerPill.style.display = 'none';
      headerMuteBtn.style.display = 'none';
      wdMuteBtn.style.display = 'none';
      banner.classList.remove('visible');
      statusCard.classList.remove('ringing');
      return;
    }

    headerPill.style.display = 'inline-block';
    headerPill.textContent = 'ocioso: ' + fmtMmSs(idleSec) + ' / ' + fmtShortLimit(limitSec);

    if (isPausedByInFlight) {
      tabBadge.className = 'badge running';
      tabBadge.textContent = 'EXEC';
      stateBadge.className = 'badge running';
      stateBadge.textContent = 'PAUSADO (COMANDO EM EXECUCAO)';
      headerPill.className = 'badge running mono';
      headerPill.textContent = 'em execucao (' + inFlight + ')';
      headerMuteBtn.style.display = 'none';
      wdMuteBtn.style.display = 'none';
      banner.classList.remove('visible');
      statusCard.classList.remove('ringing');
      return;
    }

    if (idleSec >= limitSec) {
      if (!watchdog.activeIncident) {
        watchdog.activeIncident = {
          idleSinceMs: effectiveLastMs,
          idleSinceIso: new Date(effectiveLastMs).toISOString(),
          triggeredAtMs: now,
          triggeredAtIso: new Date(now).toISOString(),
          lastTool: watchdog.lastTool,
          lastSummary: watchdog.lastSummary,
          status: watchdog.mutedForCycle ? 'muted' : 'ringing',
          resumedAtMs: null,
          resumedAtIso: null,
        };
        watchdog.history.unshift(watchdog.activeIncident);
        renderAlertHistory();
        if (!watchdog.mutedForCycle) {
          triggerDesktopNotification(idleSec);
        }
      }

      if (!watchdog.mutedForCycle) {
        watchdog.ringing = true;
        const shouldBeep = watchdog.lastBeepAtMs === 0 ||
          (alertCfg.repeatSec > 0 && now - watchdog.lastBeepAtMs >= alertCfg.repeatSec * 1000);
        if (shouldBeep) {
          watchdog.lastBeepAtMs = now;
          playAlertSound(alertCfg.soundType, alertCfg.volume);
        }

        tabBadge.className = 'badge alert-ringing';
        tabBadge.textContent = 'ALERTA!';
        stateBadge.className = 'badge alert-ringing';
        stateBadge.textContent = 'ALERTA DE INATIVIDADE DISPARADO';
        headerPill.className = 'badge alert-ringing mono';
        headerMuteBtn.style.display = 'inline-block';
        wdMuteBtn.style.display = 'inline-block';
        banner.classList.add('visible');
        statusCard.classList.add('ringing');
        el('global-alert-title').textContent = 'Alerta: MCP sem movimentacao ha ' + fmtMmSs(idleSec) + ' (limite: ' + fmtShortLimit(limitSec) + ')';
        el('global-alert-desc').textContent = 'Ultima atividade: ' + (watchdog.lastTool || '-') + ' — ' + (watchdog.lastSummary || '-');
        document.title = '[INATIVO ' + fmtMmSs(idleSec) + '] ' + BASE_DOC_TITLE;
      } else {
        tabBadge.className = 'badge warn';
        tabBadge.textContent = 'SILENCIADO';
        stateBadge.className = 'badge warn';
        stateBadge.textContent = 'SILENCIADO (AGUARDANDO RETOMADA)';
        headerPill.className = 'badge warn mono';
        headerMuteBtn.style.display = 'none';
        wdMuteBtn.style.display = 'none';
        banner.classList.remove('visible');
        statusCard.classList.remove('ringing');
      }
      if (state.activeTab === 'alerts' && watchdog.activeIncident) {
        renderAlertHistory();
      }
      return;
    }

    watchdog.lastBeepAtMs = 0;
    tabBadge.className = 'badge ok';
    tabBadge.textContent = 'ATIVO • ' + fmtShortLimit(limitSec);
    stateBadge.className = 'badge ok';
    stateBadge.textContent = 'MONITORANDO';
    headerPill.className = ratio >= 0.75 ? 'badge warn mono' : 'badge ok mono';
    headerMuteBtn.style.display = 'none';
    wdMuteBtn.style.display = 'none';
    banner.classList.remove('visible');
    statusCard.classList.remove('ringing');
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
      alertHistory: watchdog.history,
    }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mcp-logs-' + Date.now() + '.json';
    a.click();
  });

  el('idle-header-pill').addEventListener('click', () => switchTab('alerts'));
  el('btn-banner-open-tab').addEventListener('click', () => switchTab('alerts'));
  el('btn-header-mute').addEventListener('click', muteCurrentAlert);
  el('btn-banner-mute').addEventListener('click', muteCurrentAlert);
  el('btn-wd-mute').addEventListener('click', muteCurrentAlert);
  el('btn-banner-reset').addEventListener('click', resetWatchdogTimer);
  el('btn-wd-reset').addEventListener('click', resetWatchdogTimer);

  el('btn-wd-toggle').addEventListener('click', () => {
    setAlertEnabled(!alertCfg.enabled);
  });

  el('cfg-alert-enabled').addEventListener('change', (ev) => {
    setAlertEnabled(ev.target.checked);
  });

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      ensureAudioContext();
      const sec = Number(btn.getAttribute('data-preset-sec'));
      if (sec > 0) {
        alertCfg.timeoutSec = sec;
        setAlertEnabled(true);
      }
    });
  });

  function onCustomTimeoutChange() {
    ensureAudioContext();
    const mins = Math.max(0, Math.min(240, Number(el('cfg-timeout-min').value) || 0));
    const secs = Math.max(0, Math.min(59, Number(el('cfg-timeout-sec').value) || 0));
    const total = Math.max(5, mins * 60 + secs);
    alertCfg.timeoutSec = total;
    watchdog.mutedForCycle = false;
    saveAlertCfg();
    syncAlertConfigUi();
    tickWatchdog();
  }

  el('cfg-timeout-min').addEventListener('change', onCustomTimeoutChange);
  el('cfg-timeout-sec').addEventListener('change', onCustomTimeoutChange);

  el('cfg-alert-scope').addEventListener('change', (ev) => {
    alertCfg.scope = ev.target.value === 'all' ? 'all' : 'tool_call';
    saveAlertCfg();
    tickWatchdog();
  });

  el('cfg-pause-inflight').addEventListener('change', (ev) => {
    alertCfg.pauseWhenInFlight = Boolean(ev.target.checked);
    saveAlertCfg();
    tickWatchdog();
  });

  el('cfg-sound-type').addEventListener('change', (ev) => {
    alertCfg.soundType = ev.target.value;
    saveAlertCfg();
    playAlertSound(alertCfg.soundType, alertCfg.volume);
  });

  el('cfg-repeat-sec').addEventListener('change', (ev) => {
    alertCfg.repeatSec = Number(ev.target.value) || 0;
    saveAlertCfg();
  });

  el('cfg-volume').addEventListener('input', (ev) => {
    alertCfg.volume = Number(ev.target.value) || 80;
    el('cfg-volume-label').textContent = alertCfg.volume + '%';
    saveAlertCfg();
  });

  el('cfg-desktop-notify').addEventListener('change', (ev) => {
    const checked = Boolean(ev.target.checked);
    if (checked && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(() => {
        updateNotifyPermLabel();
      }).catch(() => {});
    }
    alertCfg.desktopNotify = checked;
    saveAlertCfg();
    updateNotifyPermLabel();
  });

  el('btn-wd-test-sound').addEventListener('click', () => {
    playAlertSound(alertCfg.soundType, alertCfg.volume);
  });

  el('btn-clear-alert-history').addEventListener('click', () => {
    watchdog.history = watchdog.activeIncident ? [watchdog.activeIncident] : [];
    renderAlertHistory();
  });

  function fmtDateShort(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour12: false });
  }

  function renderDeltaBadge(currVal, baseVal, unit, higherIsBetter) {
    if (baseVal === undefined || baseVal === null || !Number.isFinite(baseVal)) return '';
    const diff = Math.round((currVal - baseVal) * 100) / 100;
    if (Math.abs(diff) < 0.01) {
      return '<span class="badge neutral">= 0' + unit + ' vs base</span>';
    }
    const sign = diff > 0 ? '+' : '';
    const isGood = higherIsBetter ? diff > 0 : diff < 0;
    const cls = isGood ? 'ok' : 'warn';
    return '<span class="badge ' + cls + '">' + sign + diff + unit + ' vs base</span>';
  }

  function updateKpiTabBadge(report) {
    const badge = el('kpi-tab-badge');
    if (!badge || !report || !report.current) return;
    const sr = report.current.sampleReadiness;
    if (!sr) return;
    if (sr.stage === 'PRONTA') {
      badge.className = 'badge ok';
      badge.textContent = 'PRONTA';
    } else if (sr.stage === 'PRELIMINAR') {
      badge.className = 'badge warn';
      badge.textContent = 'PRELIM (' + sr.calls.current + '/' + sr.calls.target + ')';
    } else {
      badge.className = 'badge neutral';
      badge.textContent = sr.calls.current + '/' + sr.calls.target;
    }
  }

  function renderKpiReport(report) {
    if (!report || !report.current) return;
    state.kpiReport = report;
    updateKpiTabBadge(report);

    const c = report.current;
    const b = report.baseline;
    const vc = report.versionCounts || {};
    el('kpi-version-counts').textContent =
      'v1.4.8: ' + (vc['1.4.8'] || 0) + ' | v1.4.7: ' + (vc['1.4.7'] || 0) + ' | v1.4.6: ' + (vc['1.4.6'] || 0) + ' | v1.4.5: ' + (vc['1.4.5'] || 0) + ' | v1.4.4: ' + (vc['1.4.4'] || 0) + ' | v1.4.3: ' + (vc['1.4.3'] || 0) + ' | pre-1.4.3: ' + (vc['pre-1.4.3'] || 0);

    const sr = c.sampleReadiness;
    const rBadge = el('kpi-readiness-badge');
    if (sr.stage === 'PRONTA') {
      rBadge.className = 'badge ok';
      rBadge.textContent = 'PRONTA PARA REAVALIACAO';
    } else if (sr.stage === 'PRELIMINAR') {
      rBadge.className = 'badge warn';
      rBadge.textContent = 'AMOSTRA PRELIMINAR';
    } else {
      rBadge.className = 'badge neutral';
      rBadge.textContent = 'COLETA INICIAL';
    }

    el('kpi-window-range').textContent =
      c.windowLabel + ' • ' +
      (c.firstTimestamp ? fmtDateShort(c.firstTimestamp) + ' ate ' + fmtDateShort(c.lastTimestamp) + ' (' + c.spanDays + 'd / ' + c.activeDaysCount + 'd ativos)' : 'Sem registros na janela');
    el('kpi-readiness-pct').textContent = sr.overallProgressPct + '%';

    const rBar = el('kpi-readiness-bar');
    rBar.style.width = Math.min(100, Math.max(0, sr.overallProgressPct)) + '%';
    rBar.style.backgroundColor = sr.stage === 'PRONTA' ? 'var(--ok)' : (sr.stage === 'PRELIMINAR' ? 'var(--accent)' : 'var(--warn)');

    const pillars = [
      {
        label: '1. Volume Total de Chamadas',
        val: sr.calls.current + ' / ' + sr.calls.target,
        sub: 'Preliminar: ' + sr.calls.preliminary + ' calls (' + sr.calls.pct + '%)',
        pct: sr.calls.pct,
        ok: sr.calls.current >= sr.calls.target,
      },
      {
        label: '2. Amostra de Edicoes (edit + multi_edit)',
        val: sr.edits.current + ' / ' + sr.edits.target,
        sub: 'Preliminar: ' + sr.edits.preliminary + ' edicoes (' + sr.edits.pct + '%)',
        pct: sr.edits.pct,
        ok: sr.edits.current >= sr.edits.target,
      },
      {
        label: '3. Amostra de Jobs (poll_command)',
        val: sr.polls.current + ' / ' + sr.polls.target,
        sub: 'Preliminar: ' + sr.polls.preliminary + ' polls (' + sr.polls.pct + '%)',
        pct: sr.polls.pct,
        ok: sr.polls.current >= sr.polls.target,
      },
      {
        label: '4. Criterio Hibrido Temporal',
        val: sr.days.current + 'd / ' + sr.days.target + 'd',
        sub: sr.days.activeDays + ' dia(s) ativos (min. ' + sr.days.minCallsForDays + ' calls)',
        pct: sr.days.pct,
        ok: sr.days.current >= sr.days.target && sr.calls.current >= sr.days.minCallsForDays,
      },
    ];

    el('kpi-pillars-grid').innerHTML = pillars.map((p) => {
      const color = p.ok ? 'var(--ok)' : (p.pct >= 35 ? 'var(--accent)' : 'var(--warn)');
      return '<div class="kpi-pillar">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;">' +
          '<span class="muted">' + esc(p.label) + '</span>' +
          '<strong class="mono">' + esc(p.val) + '</strong>' +
        '</div>' +
        '<div class="wd-progress-track" style="height:6px;">' +
          '<div class="wd-progress-fill" style="width:' + Math.min(100, p.pct) + '%;background:' + color + ';"></div>' +
        '</div>' +
        '<div class="muted mono" style="font-size:11px;">' + esc(p.sub) + '</div>' +
      '</div>';
    }).join('');

    const cards = [
      {
        title: 'Confiabilidade Global',
        meta: 'Meta >= 99.0%',
        ok: c.reliability.successRatePct >= 99.0,
        mainVal: c.reliability.successRatePct.toFixed(2) + '%',
        delta: b ? renderDeltaBadge(c.reliability.successRatePct, b.reliability.successRatePct, ' p.p.', true) : '',
        rows: [
          ['Total de chamadas / Erros', c.reliability.totalCalls + ' / ' + c.reliability.totalErrors + ' (' + c.reliability.errorRatePct + '%)'],
          ['Baseline (' + (b ? b.windowKey : 'n/a') + ')', b ? (b.reliability.successRatePct.toFixed(2) + '% (' + b.reliability.totalErrors + ' erros em ' + b.reliability.totalCalls + ')') : '-'],
          ['Latencia media global', c.latency.avgGlobalMs + ' ms'],
        ],
      },
      {
        title: 'Qualidade de Edicao (1a Tentativa)',
        meta: 'Meta >= 95.0%',
        ok: c.editing.firstPassSuccessPct >= 95.0,
        mainVal: c.editing.firstPassSuccessPct.toFixed(1) + '%',
        delta: b ? renderDeltaBadge(c.editing.firstPassSuccessPct, b.editing.firstPassSuccessPct, ' p.p.', true) : '',
        rows: [
          ['Edicoes (multi_edit / edit_file)', c.editing.totalEdits + ' (' + c.editing.multiEditFileCalls + ' / ' + c.editing.editFileCalls + ') • ' + c.editing.editErrors + ' falha(s)'],
          ['Auto-recuperacao s/ read_file (Self-Heal)', c.editing.selfHealRatePct + '% (' + c.editing.selfHealedWithoutRead + '/' + c.editing.recoverableErrors + ') | Total: ' + c.editing.totalRecoveryRatePct + '%'],
          ['Causas (colisao / ausente / ENOENT)', c.editing.causes.multipleOccurrences + ' / ' + c.editing.causes.missingOldString + ' / ' + c.editing.causes.enoent],
        ],
      },
      {
        title: 'Eficiencia de Jobs & Polling',
        meta: 'Wait >= 60s: >= 90%',
        ok: c.polling.longWaitPollPct >= 90.0 && c.polling.pollErrors === 0,
        mainVal: c.polling.longWaitPollPct.toFixed(1) + '%',
        delta: b ? renderDeltaBadge(c.polling.longWaitPollPct, b.polling.longWaitPollPct, ' p.p.', true) : '',
        rows: [
          ['Densidade de polling (polls/job)', c.polling.pollsPerJob + ' (' + c.polling.pollCommandCalls + ' polls / ' + c.polling.startCommandCalls + ' jobs)'],
          ['Paginacao incremental (offset > 0)', c.polling.incrementalOffsetPct + '% (' + c.polling.incrementalOffsetPolls + ' calls)'],
          ['Erros de job_id / Auto-corrigidos', c.polling.pollErrors + ' erro(s) / ' + c.polling.autoCorrectedJobIds + ' typo(s) corrigido(s)'],
        ],
      },
      {
        title: 'Higiene de Ambiente & Tools Nativas',
        meta: 'Nativas >= 95% | NVM=0',
        ok: c.hygiene.nativeToolAdoptionPct >= 95.0 && c.hygiene.manualNvmCalls === 0,
        mainVal: c.hygiene.nativeToolAdoptionPct.toFixed(1) + '%',
        delta: b ? renderDeltaBadge(c.hygiene.nativeToolAdoptionPct, b.hygiene.nativeToolAdoptionPct, ' p.p.', true) : '',
        rows: [
          ['Workaround manual NVM (export PATH)', c.hygiene.manualNvmCalls + ' calls (' + c.hygiene.manualNvmRatePct + '%) vs ' + (b ? b.hygiene.manualNvmCalls : '-')],
          ['Leitura/busca nativa vs shell puro', c.hygiene.nativeReadSearchCalls + ' nativas vs ' + c.hygiene.shellReadSearchAntiPatterns + ' shell'],
          ['Timeouts sincronos em run_command', c.hygiene.syncTimeouts + ' (' + c.hygiene.syncTimeoutRatePct + '%)'],
        ],
      },
      {
        title: 'Economia de Contexto & Batching',
        meta: 'Batch Edit >= 60%',
        ok: c.batching.editBatchRatioPct >= 60.0,
        mainVal: c.batching.editBatchRatioPct.toFixed(1) + '%',
        delta: b ? renderDeltaBadge(c.batching.editBatchRatioPct, b.batching.editBatchRatioPct, ' p.p.', true) : '',
        rows: [
          ['Leitura em lote (read_files)', c.batching.readBatchRatioPct + '% (' + c.batching.readFilesCalls + '/' + (c.batching.readFileCalls + c.batching.readFilesCalls) + ' • media ' + c.batching.avgFilesPerReadBatch + ' arqs)'],
          ['Blocos por multi_edit_file', 'media ' + c.batching.avgEditsPerMultiEdit + ' blocos/chamada'],
          ['Payload de resposta (media / p95)', c.batching.avgPayloadChars + ' / ' + c.batching.p95PayloadChars + ' chars'],
        ],
      },
      {
        title: 'Latencia Nativa Local (p50 / p95)',
        meta: 'p50 <= 15ms | p95 <= 100ms',
        ok: c.latency.p50LocalMs <= 15 && c.latency.p95LocalMs <= 100,
        mainVal: c.latency.p50LocalMs + ' / ' + c.latency.p95LocalMs + ' ms',
        delta: b ? renderDeltaBadge(c.latency.p95LocalMs, b.latency.p95LocalMs, ' ms (p95)', false) : '',
        rows: [
          ['Execucoes locais (arquivos/busca)', c.latency.localToolCalls + ' chamadas'],
          ['Media das ferramentas locais', c.latency.avgLocalMs + ' ms'],
          ['Baseline p50 / p95', b ? (b.latency.p50LocalMs + ' / ' + b.latency.p95LocalMs + ' ms') : '-'],
        ],
      },
    ];

    el('kpi-qual-grid').innerHTML = cards.map((card) => {
      return '<div class="kpi-scorecard">' +
        '<div class="kpi-scorecard-head">' +
          '<span class="kpi-scorecard-title">' + esc(card.title) + '</span>' +
          '<span class="badge ' + (card.ok ? 'ok' : 'warn') + '">' + esc(card.meta) + '</span>' +
        '</div>' +
        '<div class="kpi-scorecard-main">' +
          '<span class="kpi-scorecard-val" style="color:' + (card.ok ? 'var(--ok)' : 'var(--warn)') + '">' + esc(card.mainVal) + '</span>' +
          card.delta +
        '</div>' +
        '<div class="kpi-sub-list">' +
          card.rows.map((r) => '<div class="kpi-sub-row"><span>' + esc(r[0]) + '</span><strong>' + esc(r[1]) + '</strong></div>').join('') +
        '</div>' +
      '</div>';
    }).join('');

    const baseToolMap = new Map();
    if (b && Array.isArray(b.byTool)) {
      for (const bt of b.byTool) baseToolMap.set(bt.tool, bt);
    }

    const toolRows = c.byTool || [];
    el('kpi-tools-count-badge').textContent = String(toolRows.length);
    const toolsTbody = el('kpi-tools-tbody');
    if (toolRows.length === 0) {
      toolsTbody.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma chamada registrada nesta janela.</td></tr>';
    } else {
      toolsTbody.innerHTML = toolRows.map((row) => {
        const bt = baseToolMap.get(row.tool);
        const baseLabel = bt
          ? (bt.errorRatePct.toFixed(1) + '% (' + bt.errors + '/' + bt.calls + ') ' + renderDeltaBadge(row.errorRatePct, bt.errorRatePct, ' p.p.', false))
          : '<span class="muted">-</span>';
        const isHealthy = row.errorRatePct <= 2.0 || (row.tool === 'multi_edit_file' && row.errorRatePct <= 5.0);
        return '<tr>' +
          '<td class="mono"><strong>' + esc(row.tool) + '</strong></td>' +
          '<td class="mono">' + row.calls + ' <span class="muted">(' + row.sharePct + '%)</span></td>' +
          '<td class="mono">' + row.errors + ' <span class="' + (row.errors > 0 ? 'badge warn' : 'badge ok') + '">' + row.errorRatePct.toFixed(1) + '%</span></td>' +
          '<td class="mono">' + baseLabel + '</td>' +
          '<td class="mono">' + row.avgMs + ' / ' + row.p50Ms + ' / ' + row.p95Ms + ' ms</td>' +
          '<td class="mono">' + row.avgChars + ' / ' + row.p95Chars + '</td>' +
          '<td><span class="badge ' + (isHealthy ? 'ok' : 'warn') + '">' + (isHealthy ? 'DENTRO DA META' : 'MONITORAR') + '</span></td>' +
        '</tr>';
      }).join('');
    }

    const eb = c.diagnostics.errorBreakdown;
    const beb = b ? b.diagnostics.errorBreakdown : null;
    const diagRows = [
      ['Edicao: old_string com multiplas ocorrencias (colisao)', eb.multipleOccurrences, beb ? beb.multipleOccurrences : '-', eb.multipleOccurrences === 0 ? 'ok' : 'warn'],
      ['Edicao: old_string nao encontrado no arquivo', eb.missingOldString, beb ? beb.missingOldString : '-', eb.missingOldString === 0 ? 'ok' : 'warn'],
      ['Arquivo ou diretorio inexistente (ENOENT)', eb.enoent, beb ? beb.enoent : '-', eb.enoent === 0 ? 'ok' : 'warn'],
      ['Job: job_id nao encontrado em poll_command', eb.invalidJobId, beb ? beb.invalidJobId : '-', eb.invalidJobId === 0 ? 'ok' : 'error'],
      ['Comando: timeout sincrono em run_command', eb.syncTimeout, beb ? beb.syncTimeout : '-', eb.syncTimeout === 0 ? 'ok' : 'warn'],
      ['Anti-padrao: export PATH manual do NVM', c.hygiene.manualNvmCalls, b ? b.hygiene.manualNvmCalls : '-', c.hygiene.manualNvmCalls === 0 ? 'ok' : 'warn'],
      ['Anti-padrao: cat/grep/find/ls puro via run_command', c.hygiene.shellReadSearchAntiPatterns, b ? b.hygiene.shellReadSearchAntiPatterns : '-', c.hygiene.shellReadSearchAntiPatterns === 0 ? 'ok' : 'warn'],
    ];

    el('kpi-diag-breakdown-tbody').innerHTML = diagRows.map((r) => {
      return '<tr>' +
        '<td>' + esc(r[0]) + '</td>' +
        '<td class="mono"><strong>' + esc(r[1]) + '</strong></td>' +
        '<td class="mono muted">' + esc(r[2]) + '</td>' +
        '<td><span class="badge ' + r[3] + '">' + (r[3] === 'ok' ? 'ZERO' : 'OCORRENCIA') + '</span></td>' +
      '</tr>';
    }).join('');

    const recErrs = c.diagnostics.recentErrors || [];
    const errTbody = el('kpi-recent-errors-tbody');
    if (recErrs.length === 0) {
      errTbody.innerHTML = '<tr><td colspan="4" class="empty">Nenhum erro registrado nesta janela.</td></tr>';
    } else {
      errTbody.innerHTML = recErrs.map((er) => {
        return '<tr>' +
          '<td class="mono muted">' + fmtTime(er.timestamp) + '</td>' +
          '<td class="mono"><strong>' + esc(er.tool) + '</strong></td>' +
          '<td><span class="truncate mono" style="max-width:220px;">' + esc(er.target) + '</span></td>' +
          '<td><span class="truncate mono" style="max-width:340px;color:var(--err);">' + esc(er.error) + '</span></td>' +
        '</tr>';
      }).join('');
    }
  }

  function fetchKpis() {
    const win = el('kpi-window-select').value || 'v1.4.8';
    const cmp = el('kpi-compare-select').value || 'v1.4.7';
    state.lastKpiFetchMs = Date.now();
    fetch('/logs/kpis?window=' + encodeURIComponent(win) + '&compare=' + encodeURIComponent(cmp))
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) renderKpiReport(data);
      })
      .catch(() => {});
  }

  el('kpi-window-select').addEventListener('change', fetchKpis);
  el('kpi-compare-select').addEventListener('change', fetchKpis);
  el('btn-kpi-refresh').addEventListener('click', fetchKpis);

  syncAlertConfigUi();
  tickWatchdog();

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
      watchdog.lastTxTimeMs = state.serverStartedAt || Date.now();
      for (let i = state.transactions.length - 1; i >= 0; i--) {
        const tx = state.transactions[i];
        state.txById.set(tx.id, tx);
        syncToolFilter(tx.tool);
        recordWatchdogActivity(tx, true);
      }
      updateKpis(snap.stats);
      if (snap.kpis) {
        renderKpiReport(snap.kpis);
      } else {
        fetchKpis();
      }
      tickWatchdog();
      if (!state.paused) {
        renderSessions();
        renderTransactions();
      }
    });

    es.addEventListener('session', (ev) => {
      const data = JSON.parse(ev.data);
      if (data.session) state.sessions.set(data.session.sessionId, data.session);
      if (alertCfg.scope === 'all') {
        watchdog.lastTxTimeMs = Date.now();
        watchdog.lastTxIso = new Date().toISOString();
        watchdog.lastTool = 'session';
        watchdog.lastSummary = data.session ? ('Sessao ' + data.session.sessionId) : 'Evento de sessao';
        resolveActiveIncident(watchdog.lastTxIso);
      }
      updateKpis(data.stats);
      tickWatchdog();
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
        recordWatchdogActivity(tx, false);
      }
      updateKpis(data.stats);
      tickWatchdog();
      if (!state.paused) {
        renderTransactions();
        if (tx && tx.status !== 'running' && (state.activeTab === 'kpis' || Date.now() - state.lastKpiFetchMs > 5000)) {
          fetchKpis();
        }
      }
    });
  }

  setInterval(() => {
    if (state.serverStartedAt) {
      const sec = Math.max(0, Math.floor((Date.now() - state.serverStartedAt) / 1000));
      el('uptime-label').textContent = 'uptime: ' + fmtUptime(sec);
    }
    tickWatchdog();
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
