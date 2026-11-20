import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DevAgentOAuthProvider } from '../dist/oauth.js';

test('OAuth migra estado legado para hashes e cria backup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-migration-'));
  const statePath = path.join(root, 'oauth-state.json');
  const accessToken = 'legacy-access-token';
  await writeFile(
    statePath,
    JSON.stringify({
      clients: {},
      accessTokens: { [accessToken]: { clientId: 'client-1', scopes: ['tools'], expiresAt: Math.floor(Date.now() / 1000) + 300 } },
      refreshTokens: {},
    }),
    { mode: 0o600 },
  );
  try {
    const provider = new DevAgentOAuthProvider(root, 'password');
    const auth = await provider.verifyAccessToken(accessToken);
    assert.equal(auth.clientId, 'client-1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stateText = await readFile(statePath, 'utf8');
    assert.match(stateText, /"tokenHashVersion":1/);
    assert.doesNotMatch(stateText, new RegExp(accessToken));
    const backups = (await readdir(root)).filter((name) => name.startsWith('oauth-state.json.bak.'));
    assert.equal(backups.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OAuth rejeita estado corrompido em vez de iniciar vazio', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-invalid-'));
  try {
    await writeFile(path.join(root, 'oauth-state.json'), '{invalido', { mode: 0o600 });
    assert.throws(() => new DevAgentOAuthProvider(root, 'password'), /Estado OAuth invalido/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
