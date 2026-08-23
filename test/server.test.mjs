import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`servidor encerrou antes do health check: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return await response.json();
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError ?? new Error('health check nao respondeu');
}

function parseMcpBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLine = trimmed.split(/\r?\n/).find((line) => line.startsWith('data:'));
  if (!dataLine) throw new Error(`resposta MCP inesperada: ${trimmed.slice(0, 500)}`);
  return JSON.parse(dataLine.slice(5).trim());
}

async function mcpPost(baseUrl, token, body, sessionId, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: parseMcpBody(text), text };
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

test('servidor integra auth, sessoes MCP, auditoria, proxy e OAuth PKCE', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-server-test-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const auditPath = path.join(root, 'audit', 'audit.jsonl');
  const dataDir = path.join(root, 'data');
  const staticToken = 'integration-static-token';
  const approvalPassword = 'integration-approval-password';
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_URL: baseUrl,
      MCP_AUTH_TOKEN: staticToken,
      OAUTH_APPROVAL_PASSWORD: approvalPassword,
      MCP_AUDIT_LOG_PATH: auditPath,
      MCP_AUDIT_STDERR: 'false',
      MCP_DATA_DIR: dataDir,
      MCP_TRUST_PROXY: 'loopback',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });

  try {
    const health = await waitForHealth(baseUrl, child);
    assert.equal(health.status, 'ok');
    assert.equal(health.tools.length, 10);

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate') ?? '', /resource_metadata=/);

    const forwardedIp = '203.0.113.10';
    const initialized = await mcpPost(
      baseUrl,
      staticToken,
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } } },
      undefined,
      { 'x-forwarded-for': forwardedIp },
    );
    assert.equal(initialized.response.status, 200, initialized.text);
    assert.equal(initialized.body?.result?.serverInfo?.name, 'mcp-dev-agent');
    const sessionId = initialized.response.headers.get('mcp-session-id');
    assert.ok(sessionId, 'initialize deve retornar mcp-session-id');

    const listed = await mcpPost(baseUrl, staticToken, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, sessionId);
    assert.equal(listed.response.status, 200, listed.text);
    assert.equal(listed.body?.result?.tools?.length, 10);

    const called = await mcpPost(
      baseUrl,
      staticToken,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_directory', arguments: { path: root, limit: 2 } } },
      sessionId,
    );
    assert.equal(called.response.status, 200, called.text);
    assert.equal(called.body?.result?.isError, undefined);

    const auditStat = await stat(auditPath);
    assert.equal(auditStat.mode & 0o777, 0o600, 'arquivo de auditoria deve ser privado');
    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const callAudit = auditLines.find((entry) => entry.tool === 'list_directory');
    assert.ok(callAudit, 'tools/call deve gerar registro de auditoria');
    assert.equal(callAudit.session_id, sessionId);
    assert.equal(callAudit.client_id, 'static-token');
    assert.equal(callAudit.remote_ip, forwardedIp, 'trust proxy loopback deve usar X-Forwarded-For do proxy local');
    assert.equal(callAudit.args.path, root);
    assert.equal(callAudit.result.is_error, false);

    const registered = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'integration-oauth-client',
        redirect_uris: ['http://127.0.0.1/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(registered.status, 201, await registered.clone().text());
    const client = await registered.json();
    assert.ok(client.client_id);

    const verifier = 'integration-verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'http://127.0.0.1/callback');
    authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', 'integration-state');

    const authorization = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(authorization.status, 200, await authorization.clone().text());
    const approvalHtml = await authorization.text();
    const pendingId = approvalHtml.match(/name="pending_id" value="([^"]+)"/)?.[1];
    assert.ok(pendingId, 'pagina OAuth deve conter pending_id');

    const approved = await fetch(`${baseUrl}/oauth/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.20' },
      body: new URLSearchParams({ pending_id: pendingId, password: approvalPassword }),
      redirect: 'manual',
    });
    assert.equal(approved.status, 302, await approved.clone().text());
    const callback = new URL(approved.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'integration-state');
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const tokenResponse = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: 'http://127.0.0.1/callback',
      }),
    });
    assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
    const tokens = await tokenResponse.json();
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);

    const oauthInitialized = await mcpPost(
      baseUrl,
      tokens.access_token,
      { jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oauth-test', version: '1' } } },
    );
    assert.equal(oauthInitialized.response.status, 200, oauthInitialized.text);
    assert.ok(oauthInitialized.response.headers.get('mcp-session-id'));

    const refreshedResponse = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
      }),
    });
    assert.equal(refreshedResponse.status, 200, await refreshedResponse.clone().text());
    const refreshed = await refreshedResponse.json();
    assert.ok(refreshed.access_token);
    assert.ok(refreshed.refresh_token);
    assert.notEqual(refreshed.refresh_token, tokens.refresh_token, 'refresh token deve rotacionar');

    const reuseOldRefresh = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
      }),
    });
    assert.equal(reuseOldRefresh.status, 400, 'refresh token antigo deve deixar de valer apos rotacao');

    const revoke = await fetch(`${baseUrl}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.client_id, token: refreshed.access_token }),
    });
    assert.equal(revoke.status, 200, await revoke.clone().text());

    const revokedUse = await mcpPost(
      baseUrl,
      refreshed.access_token,
      { jsonrpc: '2.0', id: 6, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'revoked-test', version: '1' } } },
    );
    assert.equal(revokedUse.response.status, 401, 'access token revogado nao pode acessar /mcp');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2_000).unref();
    });
    await rm(root, { recursive: true, force: true });
  }

  assert.doesNotMatch(stderr, /Unhandled|uncaught/i, `stderr inesperado:\n${stderr}`);
  assert.match(stdout, /MCP dev-agent ouvindo/);
});
