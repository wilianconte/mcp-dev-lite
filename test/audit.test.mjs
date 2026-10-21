import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditToolCall, sanitizeAuditValue, summarizeToolResult } from '../dist/audit.js';
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

test('summarizeToolResult extrai exit_code e timed_out de saidas de comando', () => {
  const okResult = summarizeToolResult({
    content: [{ type: 'text', text: 'exit_code: 0\nstdout:\nok' }],
  });
  assert.equal(okResult.exit_code, 0);
  assert.equal(okResult.timed_out, undefined);

  const nonZero = summarizeToolResult({
    content: [{ type: 'text', text: 'exit_code: 2\nstdout: (vazio)\nstderr:\nfalha' }],
  });
  assert.equal(nonZero.exit_code, 2);
  assert.equal(nonZero.timed_out, undefined);

  const timeoutResult = summarizeToolResult({
    content: [{ type: 'text', text: 'exit_code: timeout (timeout; grupo de processos encerrado)\nstdout: (vazio)' }],
  });
  assert.equal(timeoutResult.exit_code, 'timeout');
  assert.equal(timeoutResult.timed_out, true);

  const runningJobResult = summarizeToolResult({
    content: [{ type: 'text', text: 'job_id: 123\nstatus: running\nexit_code: running\nstdout:\nbuild...' }],
  });
  assert.equal(runningJobResult.exit_code, undefined);
  assert.equal(runningJobResult.job_status, 'running');
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
    const currentContent = await readFile(auditFile, 'utf8');
    assert.match(currentContent, /tool_3/);

    const monitor = new McpMonitor(10);
    await monitor.hydrateFromAuditFile(auditFile);
    const snap = monitor.getSnapshot();
    assert.ok(snap.transactions.some((t) => t.tool === 'tool_3'));
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
