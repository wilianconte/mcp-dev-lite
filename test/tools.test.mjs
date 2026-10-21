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
test('edit_file substitui texto literal sem interpretar padroes especiais de $', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    const file = path.join(root, 'sample.txt');
    await writeFile(file, 'const price = OLD_VALUE;\n', 'utf8');
    await tool('edit_file').handler({
      path: file,
      old_string: 'OLD_VALUE',
      new_string: '$& + $$100',
    });
    const updated = await readFile(file, 'utf8');
    assert.equal(updated, 'const price = $& + $$100;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('read_files le multiplos arquivos em paralelo e isola erro de arquivo inexistente', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    const f1 = path.join(root, 'a.txt');
    const f2 = path.join(root, 'b.txt');
    const missing = path.join(root, 'nao-existe.txt');
    await writeFile(f1, 'linha1\nlinha2\nlinha3\n', 'utf8');
    await writeFile(f2, 'conteudo-b', 'utf8');

    const res = await tool('read_files').handler({
      files: [
        { path: f1, offset: 2, limit: 1 },
        { path: f2 },
        { path: missing },
      ],
    });
    const text = textOf(res);
    assert.match(text, /\[1\/3\]/);
    assert.match(text, /linha2/);
    assert.doesNotMatch(text, /linha1/);
    assert.match(text, /\[2\/3\]/);
    assert.match(text, /conteudo-b/);
    assert.match(text, /\[3\/3\]/);
    assert.match(text, /status: error/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('search_code busca com ripgrep nativo, ignora node_modules por padrao e faz fallback de regex invalido', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    await writeFile(path.join(root, 'one.ts'), 'export const ALPHA_TOKEN = 42;\nconst font = Inter({ subsets: ["latin"] });\n', 'utf8');
    await writeFile(path.join(root, 'two.js'), 'const beta = "ignore";\n', 'utf8');
    const nmDir = path.join(root, 'node_modules', 'pkg');
    await tool('make_directory').handler({ path: nmDir });
    await writeFile(path.join(nmDir, 'index.js'), 'export const ALPHA_TOKEN = 999;\n', 'utf8');

    const found = await tool('search_code').handler({
      pattern: 'ALPHA_TOKEN',
      path: root,
      fixed_strings: true,
    });
    const foundText = textOf(found);
    assert.match(foundText, /exit_code: 0/);
    assert.match(foundText, /mode: fixed_strings/);
    assert.match(foundText, /returned_lines: 1/);
    assert.match(foundText, /ALPHA_TOKEN = 42/);
    assert.doesNotMatch(foundText, /999/);

    // Padrao com parentese aberto sem fixed_strings deve acionar fallback automatico para texto literal
    const fallback = await tool('search_code').handler({
      pattern: 'Inter(',
      path: root,
    });
    const fallbackText = textOf(fallback);
    assert.match(fallbackText, /exit_code: 0/);
    assert.match(fallbackText, /mode: fixed_strings_fallback/);
    assert.match(fallbackText, /Inter\(\{ subsets:/);

    const empty = await tool('search_code').handler({
      pattern: 'NAO_EXISTE_EM_LUGAR_NENHUM',
      path: root,
    });
    const emptyText = textOf(empty);
    assert.match(emptyText, /exit_code: 0/);
    assert.match(emptyText, /matches: 0/);
    assert.match(emptyText, /nenhuma ocorrencia encontrada/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('multi_edit_file aplica multiplas edicoes de forma atomica', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    const file = path.join(root, 'code.ts');
    await writeFile(file, 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf8');

    await tool('multi_edit_file').handler({
      path: file,
      edits: [
        { old_string: 'const a = 1;', new_string: 'const a = 10;' },
        { old_string: 'const c = 3;', new_string: 'const c = $&30;' },
      ],
    });
    assert.equal(await readFile(file, 'utf8'), 'const a = 10;\nconst b = 2;\nconst c = $&30;\n');

    await assert.rejects(
      () =>
        tool('multi_edit_file').handler({
          path: file,
          edits: [
            { old_string: 'const a = 10;', new_string: 'const a = 999;' },
            { old_string: 'TRECHO_INEXISTENTE', new_string: 'x' },
          ],
        }),
      /Edicao #2/,
    );
    // Garante atomicidade: a primeira edicao do lote que falhou nao pode ter sido gravada.
    assert.equal(await readFile(file, 'utf8'), 'const a = 10;\nconst b = 2;\nconst c = $&30;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('start_command e poll_command acompanham job em background, sugerem next_offset e permitem kill', async () => {
  const started = await tool('start_command').handler({
    command: 'printf "inicio\\n"; sleep 10; printf "fim\\n"',
    wait_ms: 150,
  });
  const startedText = textOf(started);
  assert.match(startedText, /status: running/);
  assert.match(startedText, /poll_hint: passe offset=/);
  assert.match(startedText, /inicio/);
  const jobId = startedText.match(/job_id: ([0-9a-f-]+)/)?.[1];
  assert.ok(jobId, 'deve retornar job_id');

  const killed = await tool('poll_command').handler({
    job_id: jobId,
    kill: true,
  });
  const killedText = textOf(killed);
  assert.match(killedText, /status: killed/);
  assert.match(killedText, /exit_code: killed/);
});

test('read_file bloqueia arquivos binarios com mensagem clara', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    const binFile = path.join(root, 'sample.bin');
    await writeFile(binFile, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]));
    await assert.rejects(
      () => tool('read_file').handler({ path: binFile }),
      /Arquivo binario detectado/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('find_files localiza arquivos por substring e por glob ignorando node_modules', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    await mkdir(path.join(root, 'src', 'components'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'src', 'components', 'SidebarNav.tsx'), 'export const SidebarNav = () => null;\n', 'utf8');
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {};\n', 'utf8');
    await writeFile(path.join(root, 'node_modules', 'pkg', 'SidebarNav.tsx'), 'ignored\n', 'utf8');

    const bySubstring = await tool('find_files').handler({
      path: root,
      pattern: 'sidebar',
    });
    const subText = textOf(bySubstring);
    assert.match(subText, /returned_files: 1/);
    assert.match(subText, /src\/components\/SidebarNav\.tsx/);
    assert.doesNotMatch(subText, /node_modules/);

    const byGlob = await tool('find_files').handler({
      path: root,
      pattern: '*.ts',
    });
    const globText = textOf(byGlob);
    assert.match(globText, /returned_files: 1/);
    assert.match(globText, /src\/index\.ts/);

    const byAlternation = await tool('find_files').handler({
      path: root,
      pattern: '*sidebar*|*index*.ts',
    });
    const altText = textOf(byAlternation);
    assert.match(altText, /returned_files: 2/);
    assert.match(altText, /src\/components\/SidebarNav\.tsx/);
    assert.match(altText, /src\/index\.ts/);

    const byShallowDepth = await tool('find_files').handler({
      path: path.join(root, 'src'),
      max_depth: 1,
    });
    const depthText = textOf(byShallowDepth);
    assert.match(depthText, /returned_files: 1/);
    assert.match(depthText, /src\/index\.ts/);
    assert.doesNotMatch(depthText, /SidebarNav\.tsx/);

    await assert.rejects(
      () => tool('find_files').handler({ path: path.join(root, 'src', 'pasta-inexistente') }),
      /Diretorio pai existente mais proximo/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('list_directory suporta max_depth recursivo ignorando node_modules', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    await mkdir(path.join(root, 'src', 'ui'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'src', 'ui', 'Button.tsx'), 'export {};\n', 'utf8');
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'export {};\n', 'utf8');

    const res = await tool('list_directory').handler({ path: root, max_depth: 3 });
    const text = textOf(res);
    assert.match(text, /max_depth: 3/);
    assert.match(text, /dir\s+src\/ui/);
    assert.match(text, /file\s+src\/ui\/Button\.tsx/);
    assert.doesNotMatch(text, /node_modules/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('edit_file informa linhas em ocorrencias multiplas e sugere trecho proximo quando nao encontrado', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    const file = path.join(root, 'diag.ts');
    await writeFile(
      file,
      'const alpha = 1;\nconst targetLine = computeValue(42);\nconst alpha = 1;\n',
      'utf8',
    );

    await assert.rejects(
      () => tool('edit_file').handler({ path: file, old_string: 'const alpha = 1;', new_string: 'const alpha = 2;' }),
      /linhas 1, 3/,
    );

    await assert.rejects(
      () =>
        tool('edit_file').handler({
          path: file,
          old_string: 'const targetLine = computeValue(999);\nconst outro = 0;',
          new_string: 'const targetLine = 0;',
        }),
      /old_string nao encontrado/,
    );

    await assert.rejects(
      () =>
        tool('edit_file').handler({
          path: file,
          old_string: '  const targetLine = computeValue(42);\n  const inexistente = true;',
          new_string: 'const targetLine = 0;',
        }),
      /Trecho similar encontrado proximo a linha 2/,
    );

    // Linha unica longa com divergencia no meio deve sugerir a linha similar via prefixo/tokens
    await assert.rejects(
      () =>
        tool('edit_file').handler({
          path: file,
          old_string: 'const targetLine = computeValue(999999);',
          new_string: 'const targetLine = 0;',
        }),
      /Trecho similar encontrado proximo a linha 2/,
    );

    // run_command com cwd inexistente deve informar o diretorio pai existente mais proximo
    await assert.rejects(
      () =>
        tool('run_command').handler({
          command: 'pwd',
          cwd: path.join(root, 'subpasta-inexistente'),
        }),
      /Diretorio pai existente mais proximo/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
