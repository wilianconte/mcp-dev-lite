import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditLogPath, auditToolCall, getAuditWriteStats, sanitizeAuditValue, summarizeToolResult } from '../dist/audit.js';
import { McpMonitor } from '../dist/monitor.js';

test('auditoria mascara segredos e limita valores grandes', () => {
  const input = {
    token: 'super-secret-token',
    nested: {
      password: 'senha',
      normal: 'ok',
    },
    command: `curl -H "Authorization: Bearer abc123" https://example.test TOKEN=xyz ${'x'.repeat(2500)}`,
  };

  const sanitized = sanitizeAuditValue(input);
  assert.equal(sanitized.token, '[REDACTED]');
  assert.equal(sanitized.nested.password, '[REDACTED]');
  assert.equal(sanitized.nested.normal, 'ok');
  assert.match(sanitized.command, /Authorization: .*\[REDACTED\]/);
  assert.match(sanitized.command, /TOKEN=\[REDACTED\]/i);
  assert.doesNotMatch(sanitized.command, /abc123|xyz/);
  assert.match(sanitized.command, /\[truncated \d+ chars\]$/);
});

test('auditoria usa data/audit.jsonl por padrao quando nenhum caminho e configurado', () => {
  const previousPath = process.env.MCP_AUDIT_LOG_PATH;
  const previousDataDir = process.env.MCP_DATA_DIR;
  delete process.env.MCP_AUDIT_LOG_PATH;
  delete process.env.MCP_DATA_DIR;
  try {
    assert.equal(auditLogPath(), path.resolve('data/audit.jsonl'));
  } finally {
    if (previousPath === undefined) delete process.env.MCP_AUDIT_LOG_PATH;
    else process.env.MCP_AUDIT_LOG_PATH = previousPath;
    if (previousDataDir === undefined) delete process.env.MCP_DATA_DIR;
    else process.env.MCP_DATA_DIR = previousDataDir;
  }
});

test('summarizeToolResult extrai exit_code e timed_out de saidas de comando', () => {
  const okResult = summarizeToolResult({
    content: [{ type: 'text', text: 'exit_code: 0\nstdout:\nok' }],
  });
  assert.equal(okResult.exit_code, 0);
  assert.equal(okResult.outcome, 'success');
  assert.equal(okResult.timed_out, undefined);

  const nonZero = summarizeToolResult({
    content: [{ type: 'text', text: 'exit_code: 2\nstdout: (vazio)\nstderr:\nfalha' }],
  });
  assert.equal(nonZero.exit_code, 2);
  assert.equal(nonZero.outcome, 'command_nonzero_exit');
  assert.equal(nonZero.timed_out, undefined);

  const timeoutResult = summarizeToolResult({
    content: [{ type: 'text', text: 'exit_code: timeout (timeout; grupo de processos encerrado)\nstdout: (vazio)' }],
  });
  assert.equal(timeoutResult.exit_code, 'timeout');
  assert.equal(timeoutResult.timed_out, true);
  assert.equal(timeoutResult.outcome, 'timeout');

  const runningJobResult = summarizeToolResult({
    content: [{ type: 'text', text: 'job_id: 123\nstatus: running\nexit_code: running\nstdout:\nbuild...' }],
  });
  assert.equal(runningJobResult.exit_code, undefined);
  assert.equal(runningJobResult.job_status, 'running');
  assert.equal(runningJobResult.outcome, 'running');
});

test('McpMonitor classifica saida de comando nao zero e preserva kill intencional', () => {
  const monitor = new McpMonitor(20);
  const failed = monitor.startToolCall({ tool: 'run_command', args: { command: 'false' } });
  monitor.finishToolCall(failed, {
    result: { content: [{ type: 'text', text: 'exit_code: 1\nstdout: (vazio)' }] },
  });
  const killed = monitor.startToolCall({ tool: 'poll_command', args: { job_id: 'job-1', kill: true } });
  monitor.finishToolCall(killed, {
    result: { content: [{ type: 'text', text: 'exit_code: killed\nstatus: killed' }] },
  });

  const report = monitor.getKpiReport('v1.5.1', 'none').current;
  assert.equal(report.reliability.totalErrors, 1);
  assert.equal(report.diagnostics.errorBreakdown.commandNonzeroExit, 1);
  assert.equal(report.polling.pollErrors, 0);
  assert.equal(monitor.getStats().totalErrors, 1);
});

test('auditToolCall rotaciona audit.jsonl quando excede MCP_AUDIT_MAX_BYTES e hydrateFromAuditFile carrega cauda', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-audit-rot-'));
  const auditFile = path.join(root, 'audit.jsonl');
  const prevPath = process.env.MCP_AUDIT_LOG_PATH;
  const prevStderr = process.env.MCP_AUDIT_STDERR;
  const prevMax = process.env.MCP_AUDIT_MAX_BYTES;
  process.env.MCP_AUDIT_LOG_PATH = auditFile;
  process.env.MCP_AUDIT_STDERR = 'false';
  process.env.MCP_AUDIT_MAX_BYTES = '450';

  try {
    for (let i = 0; i < 4; i += 1) {
      await auditToolCall({
        tool: `tool_${i}`,
        args: { step: i },
        startedAtMs: Date.now() - 5,
        result: { content: [{ type: 'text', text: 'ok' }] },
      });
    }
    const rotatedStat = await stat(`${auditFile}.1`);
    assert.ok(rotatedStat.size > 0, 'arquivo rotacionado audit.jsonl.1 deve existir');
    assert.equal(rotatedStat.mode & 0o777, 0o600, 'arquivo rotacionado deve ser privado');
    const currentContent = await readFile(auditFile, 'utf8');
    assert.match(currentContent, /tool_3/);
    const auditDirStat = await stat(root);
    assert.equal(auditDirStat.mode & 0o777, 0o700, 'diretorio de auditoria deve ser privado');
    const auditStats = getAuditWriteStats();
    assert.ok(auditStats.writes >= 4, 'auditoria deve contar escritas');
    assert.ok(auditStats.totalWriteMs >= 0, 'auditoria deve medir latencia de escrita');

    const monitor = new McpMonitor(10);
    assert.equal(monitor.getSnapshot().history.hydrationStatus, 'not_started');
    await monitor.hydrateFromAuditFile(auditFile);
    const snap = monitor.getSnapshot();
    assert.equal(snap.history.hydrationStatus, 'ready');
    assert.ok(snap.history.hydratedAuditEntries >= 2);
    assert.ok(snap.transactions.some((t) => t.tool === 'tool_3'));
    assert.ok(snap.kpis, 'snapshot deve incluir relatorio inicial de kpis');
    assert.ok(snap.kpis.current.reliability.totalCalls >= 2, 'hydrateFromAuditFile deve agregar historico rotacionado (.1) e atual');
  } finally {
    if (prevPath === undefined) delete process.env.MCP_AUDIT_LOG_PATH;
    else process.env.MCP_AUDIT_LOG_PATH = prevPath;
    if (prevStderr === undefined) delete process.env.MCP_AUDIT_STDERR;
    else process.env.MCP_AUDIT_STDERR = prevStderr;
    if (prevMax === undefined) delete process.env.MCP_AUDIT_MAX_BYTES;
    else process.env.MCP_AUDIT_MAX_BYTES = prevMax;
    await rm(root, { recursive: true, force: true });
  }
});

test('auditoria serializa chamadas concorrentes antes de rotacionar o arquivo', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-audit-concurrent-'));
  const auditFile = path.join(root, 'audit.jsonl');
  const previousPath = process.env.MCP_AUDIT_LOG_PATH;
  const previousStderr = process.env.MCP_AUDIT_STDERR;
  const previousMax = process.env.MCP_AUDIT_MAX_BYTES;
  process.env.MCP_AUDIT_LOG_PATH = auditFile;
  process.env.MCP_AUDIT_STDERR = 'false';
  process.env.MCP_AUDIT_MAX_BYTES = '1000';
  try {
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        auditToolCall({
          tool: 'concurrent_tool',
          args: { index, payload: 'x'.repeat(120) },
          startedAtMs: Date.now() - 5,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }),
      ),
    );
    const currentStat = await stat(auditFile);
    const rotatedStat = await stat(`${auditFile}.1`);
    assert.ok(currentStat.size <= 1500, `arquivo atual excedeu o limite apos chamadas concorrentes: ${currentStat.size}`);
    assert.ok(rotatedStat.size <= 1500, `arquivo rotacionado excedeu o limite: ${rotatedStat.size}`);
  } finally {
    if (previousPath === undefined) delete process.env.MCP_AUDIT_LOG_PATH;
    else process.env.MCP_AUDIT_LOG_PATH = previousPath;
    if (previousStderr === undefined) delete process.env.MCP_AUDIT_STDERR;
    else process.env.MCP_AUDIT_STDERR = previousStderr;
    if (previousMax === undefined) delete process.env.MCP_AUDIT_MAX_BYTES;
    else process.env.MCP_AUDIT_MAX_BYTES = previousMax;
    await rm(root, { recursive: true, force: true });
  }
});

test('McpMonitor calcula KPIs qualitativos (Self-Heal, Polling, Higiene e Massa Critica)', () => {
  const monitor = new McpMonitor(50);
  // 1) edit_file falha por multiplas ocorrencias e se auto-recupera na chamada seguinte sem read_file (Self-Heal)
  const tx1 = monitor.startToolCall({
    tool: 'multi_edit_file',
    args: { path: '/tmp/a.yaml', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'z', new_string: 'w' }] },
  });
  monitor.finishToolCall(tx1, {
    error: new Error('Edicao #1: old_string aparece 2 vezes em /tmp/a.yaml (linhas 10, 20).'),
  });

  const tx2 = monitor.startToolCall({
    tool: 'multi_edit_file',
    args: { path: '/tmp/a.yaml', edits: [{ old_string: 'x', new_string: 'y', replace_all: true }] },
  });
  monitor.finishToolCall(tx2, {
    result: { content: [{ type: 'text', text: 'Arquivo editado: /tmp/a.yaml' }] },
  });

  // 2) start_command + poll_command com wait_ms=120000 e offset incremental + auto-correcao de job_id
  const tx3 = monitor.startToolCall({
    tool: 'start_command',
    args: { command: 'npm test' },
  });
  monitor.finishToolCall(tx3, {
    result: { content: [{ type: 'text', text: 'job_id: 11111111-2222-3333-4444-555555555555\nstatus: running' }] },
  });

  const tx4 = monitor.startToolCall({
    tool: 'poll_command',
    args: { job_id: '11111111-2222-3333-4444-555555555556', wait_ms: 120000, offset: 150 },
  });
  monitor.finishToolCall(tx4, {
    result: {
      content: [
        {
          type: 'text',
          text: 'job_id: 11111111-2222-3333-4444-555555555555\njob_id_autocorrected_from: 11111111-2222-3333-4444-555555555556\nstatus: completed\nexit_code: 0',
        },
      ],
    },
  });

  // 3) read_file com Caminho inexistente e poll_command com Job nao encontrado ou expirado devem classificar em enoent e invalidJobId
  const tx5 = monitor.startToolCall({
    tool: 'read_file',
    args: { path: '/tmp/inexistente.ts' },
  });
  monitor.finishToolCall(tx5, {
    error: new Error('Caminho inexistente em read_file: /tmp/inexistente.ts.'),
  });

  const tx6 = monitor.startToolCall({
    tool: 'poll_command',
    args: { job_id: '99999999-2222-3333-4444-555555555555', wait_ms: 60000 },
  });
  monitor.finishToolCall(tx6, {
    error: new Error('Job nao encontrado ou expirado: 99999999-2222-3333-4444-555555555555.'),
  });

  const report = monitor.getKpiReport('v1.5.1', 'v1.4.9');
  assert.equal(report.current.reliability.totalCalls, 6);
  assert.equal(report.current.reliability.totalErrors, 3);
  assert.equal(report.current.editing.totalEdits, 2);
  assert.equal(report.current.editing.editErrors, 1);
  assert.equal(report.current.editing.selfHealedWithoutRead, 1);
  assert.equal(report.current.editing.selfHealRatePct, 100);
  assert.equal(report.current.editing.causes.multipleOccurrences, 1);
  assert.equal(report.current.polling.pollCommandCalls, 2);
  assert.equal(report.current.polling.longWaitPollPct, 100);
  assert.equal(report.current.polling.incrementalOffsetPct, 50);
  assert.equal(report.current.polling.autoCorrectedJobIds, 1);
  assert.equal(report.current.diagnostics.errorBreakdown.enoent, 1);
  assert.equal(report.current.diagnostics.errorBreakdown.invalidJobId, 1);
  assert.equal(report.current.diagnostics.errorBreakdown.other, 0);
  assert.equal(report.current.sampleReadiness.stage, 'COLETA_INICIAL');
});
