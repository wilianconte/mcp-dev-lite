import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tools } from '../dist/tools.js';

const tool = (name) => {
  const found = tools.find((item) => item.name === name);
  assert.ok(found, `tool ${name} deve existir`);
  return found;
};

const textOf = (result) => result.content.find((item) => item.type === 'text')?.text ?? '';

test('run_command preserva saida grande e permite paginacao posterior', async () => {
  const result = await tool('run_command').handler({
    command: `node -e "process.stdout.write('A'.repeat(31000) + 'TAIL_MARKER')"`,
  });
  const text = textOf(result);
  assert.match(text, /saida completa preservada/);
  assert.match(text, /TAIL_MARKER/);
  const id = text.match(/artifact_id: ([0-9a-f-]+)/)?.[1];
  assert.ok(id, 'artifact_id deve ser retornado');
  const storeDir = path.join(os.tmpdir(), 'mcp-dev-agent-output');
  const stored = await stat(path.join(storeDir, `${id}.txt`));
  const directory = await stat(storeDir);
  assert.equal(stored.mode & 0o777, 0o600, 'saida temporaria deve ser privada');
  assert.equal(directory.mode & 0o777, 0o700, 'diretorio temporario deve ser privado');

  const page = await tool('read_command_output').handler({ artifact_id: id, offset: 30000, limit: 5000 });
  const pageText = textOf(page);
  assert.match(pageText, /has_more: false/);
  assert.match(pageText, /TAIL_MARKER/);
});

test('run_command encerra todo o grupo de processos no timeout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    const pidFile = path.join(root, 'child.pid');
    const result = await tool('run_command').handler({
      command: `sleep 30 & child=$!; printf '%s' "$child" > '${pidFile}'; wait`,
      timeout_ms: 100,
    });
    assert.match(textOf(result), /timeout; grupo de processos encerrado/);
    const childPid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    let alive = true;
    try { process.kill(childPid, 0); } catch { alive = false; }
    assert.equal(alive, false, `processo descendente ${childPid} nao deve sobreviver ao timeout`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read_file pagina arquivos por caracteres sem perder o restante', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    const file = path.join(root, 'minified.txt');
    await writeFile(file, 'x'.repeat(40000), 'utf8');
    const first = await tool('read_file').handler({ path: file });
    const firstText = textOf(first);
    assert.match(firstText, /has_more: true/);
    assert.match(firstText, /next_char_offset: 30000/);

    const second = await tool('read_file').handler({ path: file, char_offset: 30000, char_limit: 10000 });
    const secondText = textOf(second);
    assert.match(secondText, /has_more: false/);
    assert.match(secondText, /returned_chars: 10000/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read_image retorna ImageContent MCP com metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    const file = path.join(root, 'pixel.png');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4qQAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(file, png);
    const result = await tool('read_image').handler({ path: file });
    const image = result.content.find((item) => item.type === 'image');
    assert.ok(image, 'deve conter bloco image');
    assert.equal(image.mimeType, 'image/png');
    assert.ok(image.data.length > png.length);
    assert.match(textOf(result), /dimensions: 1x1/);
    assert.match(textOf(result), /sha256:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list_directory pagina diretorios grandes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    await Promise.all(Array.from({ length: 5 }, (_, index) => mkdir(path.join(root, `dir-${index}`))));
    const first = await tool('list_directory').handler({ path: root, limit: 2 });
    assert.match(textOf(first), /total: 5/);
    assert.match(textOf(first), /has_more: true/);
    assert.match(textOf(first), /next_offset: 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
