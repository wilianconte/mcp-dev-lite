import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAuditValue } from '../dist/audit.js';

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
