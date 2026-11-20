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
      MCP_REQUEST_BODY_LIMIT: '1kb',
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
    assert.equal(health.tools, undefined, 'health nao deve enumerar ferramentas publicamente');

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate') ?? '', /resource_metadata=/);

    const malformedAuthenticated = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staticToken}`, 'content-type': 'application/json', accept: 'application/json' },
      body: '{',
    });
    const malformedText = await malformedAuthenticated.text();
    assert.equal(malformedAuthenticated.status, 400);
    assert.match(malformedText, /SyntaxError|Unexpected end|entity.parse.failed/);
    assert.doesNotMatch(malformedText, /<html/i);

    const oversized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${staticToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { padding: 'x'.repeat(2_000) } }),
    });
    assert.equal(oversized.status, 413, 'o limite configurado do corpo deve ser aplicado após autenticacao');

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
    assert.equal(listed.body?.result?.tools?.length, 17);

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
    assert.equal(callAudit.result.outcome, 'success');

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
    const persistedOAuthState = JSON.parse(await readFile(path.join(dataDir, 'oauth-state.json'), 'utf8'));
    assert.equal(persistedOAuthState.tokenHashVersion, 1);
    assert.doesNotMatch(await readFile(path.join(dataDir, 'oauth-state.json'), 'utf8'), new RegExp(tokens.access_token));
    assert.doesNotMatch(await readFile(path.join(dataDir, 'oauth-state.json'), 'utf8'), new RegExp(tokens.refresh_token));

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

    // Validacao do painel /logs (HTML), /logs/api (JSON) e /logs/stream (SSE em tempo real).
    const anonymousLogsRes = await fetch(`${baseUrl}/logs`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    });
    assert.equal(anonymousLogsRes.status, 302, 'painel HTML sem credencial deve redirecionar para o login');
    assert.equal(anonymousLogsRes.headers.get('location'), '/logs/login');

    const loginPageRes = await fetch(`${baseUrl}/logs/login`, { headers: { accept: 'text/html' } });
    assert.equal(loginPageRes.status, 200);
    const loginPage = await loginPageRes.text();
    assert.match(loginPage, /Entrar no MCP Monitor/);
    assert.doesNotMatch(loginPage, new RegExp(staticToken));

    const invalidLoginRes = await fetch(`${baseUrl}/logs/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: new URLSearchParams({ token: 'wrong-token' }),
      redirect: 'manual',
    });
    assert.equal(invalidLoginRes.status, 401);
    assert.equal(invalidLoginRes.headers.get('set-cookie'), null, 'login invalido nao deve emitir sessao');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const limitedAttempt = await fetch(`${baseUrl}/logs/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', 'x-forwarded-for': '198.51.100.100' },
        body: new URLSearchParams({ token: 'wrong-token' }),
      });
      assert.equal(limitedAttempt.status, 401);
    }
    const limitedLoginRes = await fetch(`${baseUrl}/logs/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', 'x-forwarded-for': '198.51.100.100' },
      body: new URLSearchParams({ token: 'wrong-token' }),
    });
    assert.equal(limitedLoginRes.status, 429, 'login do painel deve aplicar limite por IP');

    const loginRes = await fetch(`${baseUrl}/logs/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: new URLSearchParams({ token: staticToken }),
      redirect: 'manual',
    });
    assert.equal(loginRes.status, 303);
    assert.equal(loginRes.headers.get('location'), '/logs');
    const loginCookie = loginRes.headers.get('set-cookie');
    assert.match(loginCookie ?? '', /mcp_monitor_session=/);

    const anonymousLogsApiRes = await fetch(`${baseUrl}/logs/api`);
    assert.equal(anonymousLogsApiRes.status, 401, '/logs/api sem credencial deve exigir autenticacao');

    const malformedCookieLogsRes = await fetch(`${baseUrl}/logs`, {
      headers: { cookie: 'mcp_monitor_session=%' },
    });
    assert.equal(malformedCookieLogsRes.status, 401, 'cookie malformado deve ser rejeitado sem erro 500');

    const staleHtmlCookieRes = await fetch(`${baseUrl}/logs`, {
      headers: { accept: 'text/html', cookie: 'mcp_monitor_session=stale-session' },
      redirect: 'manual',
    });
    assert.equal(staleHtmlCookieRes.status, 302, 'cookie HTML expirado deve redirecionar para login');
    assert.equal(staleHtmlCookieRes.headers.get('location'), '/logs/login');
    assert.match(staleHtmlCookieRes.headers.get('set-cookie') ?? '', /Max-Age=0/);

    const logsHtmlRes = await fetch(`${baseUrl}/logs`, {
      headers: { accept: 'text/html', cookie: loginCookie?.split(';', 1)[0] ?? '' },
    });
    assert.equal(logsHtmlRes.status, 200);
    const monitorCookie = loginCookie;
    assert.match(logsHtmlRes.headers.get('content-type') ?? '', /text\/html/);
    const logsHtml = await logsHtmlRes.text();
    assert.match(logsHtml, /MCP Monitor — \/logs/);
    assert.match(logsHtml, /EventSource\('\/logs\/stream'\)/);
    assert.match(logsHtml, /id="tab-btn-alerts"/);
    assert.match(logsHtml, /id="tab-panel-alerts"/);
    assert.match(logsHtml, /id="tab-btn-kpis"/);
    assert.match(logsHtml, /id="tab-panel-kpis"/);
    assert.match(logsHtml, /mcp_monitor_alert_cfg_v1/);
    assert.match(logsHtml, /action="\/logs\/logout"/);

    const kpisRes = await fetch(`${baseUrl}/logs/kpis?window=v1.5.1&compare=v1.5.0`, {
      headers: { cookie: loginCookie?.split(';', 1)[0] ?? '' },
    });
    assert.equal(kpisRes.status, 200);
    const kpiReport = await kpisRes.json();
    assert.equal(kpiReport.currentVersion, '1.5.1');
    assert.ok(kpiReport.current.reliability.totalCalls >= 1);
    assert.ok(kpiReport.cacheStats, 'kpiReport deve incluir estatisticas de cache zero-stale');
    assert.ok(kpiReport.auditWriteStats.writes >= 1, 'kpiReport deve incluir latencia e contagem de escrita da auditoria');
    assert.equal(kpiReport.current.sampleReadiness.calls.target, 1500);
    assert.equal(kpiReport.current.sampleReadiness.edits.target, 200);
    assert.equal(kpiReport.current.sampleReadiness.polls.target, 80);

    const logsApiRes = await fetch(`${baseUrl}/logs/api`, {
      headers: { cookie: loginCookie?.split(';', 1)[0] ?? '' },
    });
    assert.equal(logsApiRes.status, 200);
    const snapshot = await logsApiRes.json();
    assert.equal(snapshot.server.name, 'mcp-dev-agent');
    assert.equal(snapshot.stats.activeSessions, 2);
    assert.ok(snapshot.stats.totalToolCalls >= 1);
    assert.ok(snapshot.sessions.some((s) => s.sessionId === sessionId && s.clientName === 'integration-test'));
    const txTool = snapshot.transactions.find((t) => t.event === 'mcp.tool_call' && t.tool === 'list_directory');
    assert.ok(txTool, '/logs/api deve listar a transacao de list_directory');
    assert.equal(txTool.status, 'ok');
    assert.ok(txTool.result?.preview, 'transacao deve incluir preview sanitizado da saida');

    // Testa stream SSE (/logs/stream) recebendo snapshot inicial + nova transacao em tempo real.
    const sseAbort = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/logs/stream`, {
      headers: { cookie: monitorCookie?.split(';', 1)[0] ?? '' },
      signal: sseAbort.signal,
    });
    assert.equal(sseResponse.status, 200);
    assert.match(sseResponse.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = sseResponse.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    const readUntil = async (predicate) => {
      for (let i = 0; i < 40; i += 1) {
        if (predicate(sseBuffer)) return;
        const { value, done } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
      }
      assert.ok(predicate(sseBuffer), `SSE nao recebeu evento esperado. Buffer:\n${sseBuffer.slice(0, 800)}`);
    };

    await readUntil((buf) => buf.includes('event: snapshot'));

    await mcpPost(
      baseUrl,
      staticToken,
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'make_directory', arguments: { path: path.join(root, 'sse-dir') } } },
      sessionId,
    );

    await readUntil((buf) => buf.includes('event: transaction') && buf.includes('"tool":"make_directory"') && buf.includes('"status":"ok"'));
    sseAbort.abort();

    const logoutRes = await fetch(`${baseUrl}/logs/logout`, {
      method: 'POST',
      headers: { cookie: loginCookie?.split(';', 1)[0] ?? '' },
      redirect: 'manual',
    });
    assert.equal(logoutRes.status, 303);
    assert.equal(logoutRes.headers.get('location'), '/logs/login');
    assert.match(logoutRes.headers.get('set-cookie') ?? '', /Max-Age=0/);

    const afterLogout = await fetch(`${baseUrl}/logs/api`, {
      headers: { cookie: loginCookie?.split(';', 1)[0] ?? '' },
    });
    assert.equal(afterLogout.status, 401, 'sessao encerrada nao deve continuar acessando o painel');
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
