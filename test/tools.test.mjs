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
  assert.match(startedText, /process_alive: true/);
  assert.match(startedText, /poll_hint: passe offset=7 e wait_ms=60000 \(ate 180000\)/);
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

test('start_command e poll_command finalizam rapido mesmo com subprocesso neto segurando pipe, paginam stderr incrementalmente e compactam gh run watch', async () => {
  // 1. Subprocesso em background herdando stdout nao deve travar a finalizacao do job
  const t0 = Date.now();
  const orphanRes = await tool('start_command').handler({
    command: '(sleep 20 &) && printf "pronto_sem_travar\\n"',
    wait_ms: 3000,
  });
  const orphanElapsed = Date.now() - t0;
  const orphanText = textOf(orphanRes);
  assert.match(orphanText, /status: completed/);
  assert.match(orphanText, /pronto_sem_travar/);
  assert.ok(orphanElapsed < 2000, `deve finalizar em <2s com drain grace, levou ${orphanElapsed}ms`);
  const orphanJobId = orphanText.match(/job_id: ([0-9a-f-]+)/)?.[1];
  assert.ok(orphanJobId);
  // Encerra eventual sleep residual do grupo de processos
  await tool('poll_command').handler({ job_id: orphanJobId, kill: true });

  // 2. Paginacao incremental de stderr sincronizada com offset=next_offset e compactacao de gh run watch
  const watchCmd = [
    'printf "out1\\n"',
    'printf "err1\\n" >&2',
    'sleep 0.3',
    'printf "Refreshing run status every 3 seconds. Press Ctrl+C to quit.\\nframe1\\n"',
    'printf "Refreshing run status every 3 seconds. Press Ctrl+C to quit.\\nframe2\\n"',
    'printf "Refreshing run status every 3 seconds. Press Ctrl+C to quit.\\nframe3_final\\n"',
    'printf "err2\\n" >&2',
  ].join('; ');
  const first = await tool('start_command').handler({
    command: watchCmd,
    wait_ms: 100,
  });
  const firstText = textOf(first);
  const jobId = firstText.match(/job_id: ([0-9a-f-]+)/)?.[1];
  const nextOffset = Number(firstText.match(/next_offset: (\d+)/)?.[1] ?? '0');
  assert.ok(jobId);
  assert.match(firstText, /err1/);

  const second = await tool('poll_command').handler({
    job_id: jobId,
    offset: nextOffset,
    wait_ms: 3000,
  });
  const secondText = textOf(second);
  assert.match(secondText, /status: completed/);
  assert.match(secondText, /compacted_watch_frames: 2/);
  assert.match(secondText, /frame3_final/);
  assert.doesNotMatch(secondText, /\nframe1\n/);
  assert.match(secondText, /err2/);
  assert.doesNotMatch(secondText, /err1/);
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

test('v1.4.3: dicas inteligentes de caminho (subdiretorios estruturais + ranking por similaridade), filtro pattern em list_directory e piso wait_ms em start_command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-'));
  try {
    // 1. Subdiretorio estrutural (services/crm-api) e ranking por similaridade entre muitas entradas
    await mkdir(path.join(root, 'services', 'crm-api', 'src'), { recursive: true });
    await writeFile(path.join(root, 'services', 'crm-api', 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
    for (let i = 0; i < 20; i += 1) {
      await mkdir(path.join(root, `admin-worktree-${String(i).padStart(2, '0')}`), { recursive: true });
    }
    await mkdir(path.join(root, 'crm-api-p1-db-review-20261023'), { recursive: true });
    await writeFile(path.join(root, 'crm-api-p1-db-review-20261023', 'README.md'), '# review\n', 'utf8');

    // Ao pedir root/crm-api (esquecendo services/), deve sugerir root/services/crm-api
    await assert.rejects(
      () => tool('list_directory').handler({ path: path.join(root, 'crm-api') }),
      /Sugestao encontrada: .*services\/crm-api/,
    );

    // Ao pedir read_file em root/crm-api/src/index.ts, deve sugerir root/services/crm-api/src/index.ts
    await assert.rejects(
      () => tool('read_file').handler({ path: path.join(root, 'crm-api', 'src', 'index.ts') }),
      /Sugestao encontrada: .*services\/crm-api\/src\/index\.ts/,
    );

    // Ao pedir nome incompleto de worktree entre >20 pastas admin-*, deve ranquear crm-api-p1-db-review-20261023 no topo
    await assert.rejects(
      () => tool('list_directory').handler({ path: path.join(root, 'crm-api-p1-db-review') }),
      /Entradas disponiveis em .*: crm-api-p1-db-review-20261023\//,
    );

    // 2. list_directory com pattern e alternancia '|'
    const filteredDir = await tool('list_directory').handler({
      path: root,
      pattern: '*db-review*|services',
    });
    const filteredText = textOf(filteredDir);
    assert.match(filteredText, /total: 2/);
    assert.match(filteredText, /crm-api-p1-db-review-20261023/);
    assert.match(filteredText, /services/);
    assert.doesNotMatch(filteredText, /admin-worktree-00/);

    // 3. find_files com glob *db-review* casando nome de diretorio pai via --iglob
    const foundInWorktree = await tool('find_files').handler({
      path: root,
      pattern: '*db-review*',
    });
    const foundWorktreeText = textOf(foundInWorktree);
    assert.match(foundWorktreeText, /returned_files: 1/);
    assert.match(foundWorktreeText, /crm-api-p1-db-review-20261023\/README\.md/);

    // 4. start_command com wait_ms=1000 aguarda comando rapido de ~1.2s concluir na propria chamada
    const fastStart = await tool('start_command').handler({
      command: 'sleep 1.1 && printf "concluido_no_start\\n"',
      cwd: root,
      wait_ms: 1000,
    });
    const fastStartText = textOf(fastStart);
    assert.match(fastStartText, /status: completed/);
    assert.match(fastStartText, /concluido_no_start/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v1.4.4: extracao automatica de glob em path (search_code, find_files, list_directory) e inspecao de redirecionamento / stream-json em start_command + poll_command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-v144-'));
  try {
    const scriptsDir = path.join(root, 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(path.join(scriptsDir, 'crm-p1-hosted-alpha.test.mjs'), 'describe("alpha suite", () => {});\n', 'utf8');
    await writeFile(path.join(scriptsDir, 'crm-p1-hosted-beta.test.mjs'), 'describe("beta suite", () => {});\n', 'utf8');
    await writeFile(path.join(scriptsDir, 'other-helper.mjs'), 'describe("ignored helper", () => {});\n', 'utf8');

    // 1. search_code com glob embutido em path
    const globPath = path.join(scriptsDir, 'crm-p1-hosted-*.test.mjs');
    const searchRes = await tool('search_code').handler({
      pattern: 'describe',
      path: globPath,
    });
    const searchText = textOf(searchRes);
    assert.match(searchText, /exit_code: 0/);
    assert.match(searchText, /extracted_glob: crm-p1-hosted-\*\.test\.mjs/);
    assert.match(searchText, /alpha suite/);
    assert.match(searchText, /beta suite/);
    assert.doesNotMatch(searchText, /ignored helper/);

    // 2. find_files com glob embutido em path
    const findRes = await tool('find_files').handler({
      path: globPath,
    });
    const findText = textOf(findRes);
    assert.match(findText, /returned_files: 2/);
    assert.match(findText, /crm-p1-hosted-alpha\.test\.mjs/);
    assert.match(findText, /crm-p1-hosted-beta\.test\.mjs/);
    assert.doesNotMatch(findText, /other-helper\.mjs/);

    // 3. list_directory com glob embutido em path
    const listRes = await tool('list_directory').handler({
      path: globPath,
    });
    const listText = textOf(listRes);
    assert.match(listText, /total: 2/);
    assert.match(listText, /crm-p1-hosted-alpha\.test\.mjs/);

    // 4. start_command / poll_command com redirecionamento > stream.jsonl e wakeup antecipado em {"event":"result"}
    const streamFile = path.join(root, 'subagent-stream.jsonl');
    const errFile = path.join(root, 'subagent-stderr.log');
    const startRes = await tool('start_command').handler({
      command: `printf '{"event":"message","text":"iniciando"}\\n' > "${streamFile}" 2> "${errFile}" && sleep 0.3 && printf '{"event":"result","status":"ok"}\\n' >> "${streamFile}" && sleep 30`,
      cwd: root,
      wait_ms: 100,
    });
    const startText = textOf(startRes);
    const jobId = startText.match(/job_id: ([a-f0-9-]+)/)?.[1];
    assert.ok(jobId, 'job_id deve estar presente');
    assert.match(startText, /redirected_output_files:/);

    const t0 = Date.now();
    const pollRes = await tool('poll_command').handler({
      job_id: jobId,
      wait_ms: 15000,
    });
    const elapsedPollMs = Date.now() - t0;
    const pollText = textOf(pollRes);
    assert.ok(elapsedPollMs < 8000, `poll_command deveria retornar antecipadamente ao detectar {"event":"result"}, mas levou ${elapsedPollMs}ms`);
    assert.match(pollText, /stream_json_status: result_ready/);
    assert.match(pollText, /redirected_output_preview:/);
    assert.match(pollText, /"event":"result"/);

    // Encerra o job em background
    await tool('poll_command').handler({ job_id: jobId, kill: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v1.4.5: contexto em ocorrencias multiplas, heuristica aprimorada de edit_file/multi_edit_file, paginacao automatica de stderr com stdout=0, autocorrecao de typo em job_id e engines.node em package.json', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-v145-'));
  try {
    // 1. multi_edit_file: contexto nas ocorrencias multiplas + idempotencia para edicao duplicada no mesmo lote
    const specFile = path.join(root, 'sample.tsx');
    await writeFile(
      specFile,
      [
        'export function Form() {',
        '  return (',
        '    <Shell',
        '      title="Nova Demanda"',
        '      sidebarDescription="As novas demandas entram no estado NEW e avancam pela triagem."',
        '    >',
        '      <div className="border-slate-300 text-slate-900">Bloco A</div>',
        '      <button type="submit">Salvar</button>',
        '      <div className="border-slate-300 text-slate-700">Bloco B</div>',
        '      <button type="submit">Salvar</button>',
        '    </Shell>',
        '  );',
        '}',
      ].join('\n'),
      'utf8',
    );

    // Ocorrencias multiplas deve mostrar contexto das primeiras ocorrencias
    await assert.rejects(
      () =>
        tool('edit_file').handler({
          path: specFile,
          old_string: '      <button type="submit">Salvar</button>',
          new_string: '      <button type="submit">Confirmar</button>',
        }),
      /Contexto das primeiras ocorrencias:[\s\S]*Bloco A[\s\S]*Bloco B/,
    );

    // Ancora por propriedade JSX (sidebarDescription=...) deve sugerir a linha correta mesmo quando o texto interno mudou
    await assert.rejects(
      () =>
        tool('edit_file').handler({
          path: specFile,
          old_string: '      sidebarDescription="Texto antigo completamente diferente sobre solicitacao."',
          new_string: '      sidebarDescription="Novo texto"',
        }),
      /Trecho similar encontrado proximo a linha 5:[\s\S]*sidebarDescription="As novas demandas/,
    );

    // Edicao duplicada dentro do mesmo lote de multi_edit_file deve ser tratada como no-op idempotente
    const batchRes = await tool('multi_edit_file').handler({
      path: specFile,
      edits: [
        { old_string: 'border-slate-300', new_string: 'border-input', replace_all: true },
        { old_string: 'text-slate-900', new_string: 'text-foreground', replace_all: true },
        { old_string: 'border-slate-300', new_string: 'border-input', replace_all: true },
      ],
    });
    assert.match(textOf(batchRes), /Arquivo editado:/);

    // 2. start_command / poll_command: paginacao automatica de stderr quando stdout=0 + autocorrecao de 1-char typo no UUID
    const startRes = await tool('start_command').handler({
      command: 'printf "stderr_chunk_1\\n" >&2 && sleep 0.4 && printf "stderr_chunk_2\\n" >&2 && sleep 20',
      cwd: root,
      wait_ms: 150,
    });
    const startText = textOf(startRes);
    const jobId = startText.match(/job_id: ([0-9a-f-]{36})/)?.[1];
    assert.ok(jobId, 'jobId deve existir');
    assert.match(startText, /stderr_chunk_1/);

    await new Promise((r) => setTimeout(r, 450));

    // Simula typo de 1 caractere hexadecimal no meio do job_id
    const chars = jobId.split('');
    const flipIdx = 15;
    chars[flipIdx] = chars[flipIdx] === 'a' ? 'b' : 'a';
    const typoJobId = chars.join('');

    const pollRes = await tool('poll_command').handler({
      job_id: typoJobId,
      offset: 0,
      wait_ms: 50,
    });
    const pollText = textOf(pollRes);
    assert.match(pollText, new RegExp(`job_id: ${jobId}`));
    assert.match(pollText, new RegExp(`job_id_autocorrected_from: ${typoJobId}`));
    // Deve conter apenas stderr_chunk_2 (paginacao incremental de stderr quando stdout continua 0)
    assert.doesNotMatch(pollText, /stderr_chunk_1/);
    assert.match(pollText, /stderr_chunk_2/);

    await tool('poll_command').handler({ job_id: jobId, kill: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v1.4.6: multi_edit_file sequencial em blocos repetidos, normalizacao de trailing spaces/CRLF, ancoragem por alta entropia e delete_path em diretorio vazio', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-v146-'));
  try {
    // 1. multi_edit_file: consumo sequencial quando o lote possui N edicoes para N ocorrencias identicas
    const yamlFile = path.join(root, 'EXECUTION.yaml');
    await writeFile(
      yamlFile,
      [
        'work_packages:',
        '  - id: WP-PLAN-001',
        '    status: EXECUTING',
        '    blockers: []',
        '  - id: WP-PLAN-002',
        '    status: READY',
        '    owner: null',
        '  - id: WP-PLAN-003',
        '    status: READY',
        '    owner: null',
        '  - id: WP-PLAN-005',
        '    status: COMPLETED   ',
        '    blockers: []   ',
        '    summary: "Entrega finalizada do WP-PLAN-005"',
      ].join('\n'),
      'utf8',
    );

    const seqRes = await tool('multi_edit_file').handler({
      path: yamlFile,
      edits: [
        { old_string: '    status: READY\n    owner: null', new_string: '    status: EXECUTING\n    owner: agent-a' },
        { old_string: '    status: READY\n    owner: null', new_string: '    status: EXECUTING\n    owner: agent-b' },
      ],
    });
    assert.match(textOf(seqRes), /2 bloco\(s\) aplicados, 2 substituicao\(oes\)/);
    const afterSeq = await readFile(yamlFile, 'utf8');
    assert.match(afterSeq, /id: WP-PLAN-002\n    status: EXECUTING\n    owner: agent-a/);
    assert.match(afterSeq, /id: WP-PLAN-003\n    status: EXECUTING\n    owner: agent-b/);

    // 2. Normalizacao automatica quando a unica diferenca sao espacos em branco no final da linha
    await tool('edit_file').handler({
      path: yamlFile,
      old_string: '  - id: WP-PLAN-005\n    status: COMPLETED\n    blockers: []',
      new_string: '  - id: WP-PLAN-005\n    status: VERIFIED\n    blockers: []',
    });
    const afterNorm = await readFile(yamlFile, 'utf8');
    assert.match(afterNorm, /id: WP-PLAN-005\n    status: VERIFIED/);

    // 3. Hint de alta entropia em multi_edit_file + indicacao de edicoes anteriores validadas OK
    await assert.rejects(
      () =>
        tool('multi_edit_file').handler({
          path: yamlFile,
          edits: [
            { old_string: '  - id: WP-PLAN-001', new_string: '  - id: WP-PLAN-001' },
            {
              old_string: '    status: EXECUTING\n    blockers: []\n    summary: "Resumo antigo do WP-PLAN-005"',
              new_string: '    status: DONE',
            },
          ],
        }),
      /Edicao #2 \(edicoes #1\.\.#1 validadas OK\):[\s\S]*WP-PLAN-005/,
    );

    // 4. delete_path em diretorio vazio sem recursive=true deve excluir sem erro; em nao-vazio deve orientar recursive=true
    const emptyDir = path.join(root, 'empty-folder');
    await mkdir(emptyDir, { recursive: true });
    const delEmpty = await tool('delete_path').handler({ path: emptyDir });
    assert.match(textOf(delEmpty), /Excluido:/);

    const nonEmptyDir = path.join(root, 'non-empty-folder');
    await mkdir(nonEmptyDir, { recursive: true });
    await writeFile(path.join(nonEmptyDir, 'file.txt'), 'ok', 'utf8');
    await assert.rejects(
      () => tool('delete_path').handler({ path: nonEmptyDir }),
      /Passe recursive=true em delete_path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v1.4.7: normalizacao de indentacao a esquerda, validacao multi-bloco em multi_edit_file, sugestao de typo Levenshtein, stat_path e allow_missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-v147-'));
  try {
    // 1. Tolerancia a diferenca de indentacao a esquerda (leading whitespace) com ajuste proporcional de new_string
    const tsFile = path.join(root, 'config.spec.ts');
    await writeFile(
      tsFile,
      [
        'describe("config", () => {',
        '  const cfg = {',
        '      baseUrl: "https://auth.dev.example.test",',
        '      projectId: "project-dev",',
        '      organizationId: "org-dev",',
        '  };',
        '});',
      ].join('\n'),
      'utf8',
    );

    await tool('edit_file').handler({
      path: tsFile,
      old_string: '        organizationId: "org-dev",',
      new_string: '        organizationId: "org-dev",\n        machineKeyFile: "/var/run/secrets/key.json",',
    });
    const afterIndentEdit = await readFile(tsFile, 'utf8');
    assert.match(afterIndentEdit, /\n      organizationId: "org-dev",\n      machineKeyFile: "\/var\/run\/secrets\/key\.json",/);

    // 1b. Idempotencia: repetir a mesma edicao quando new_string ja esta aplicado no arquivo nao deve falhar
    const idempRes = await tool('edit_file').handler({
      path: tsFile,
      old_string: '      organizationId: "org-dev",',
      new_string: '      organizationId: "org-dev",\n      machineKeyFile: "/var/run/secrets/key.json",',
    });
    assert.match(textOf(idempRes), /idempotente/);

    // 2. multi_edit_file: validacao multi-bloco reportando todos os blocos invalidos de uma vez
    const statusMd = path.join(root, 'STATUS.md');
    await writeFile(
      statusMd,
      [
        '# Status',
        '',
        '## Bloqueios ativos',
        '1. **WP-016 — rate limit:** amostra 13:26Z registrou 30/70 CRs.',
        '',
        '## Proximas acoes',
        '1. Revisar e integrar a PR GitOps DEV #1101.',
      ].join('\n'),
      'utf8',
    );

    await assert.rejects(
      () =>
        tool('multi_edit_file').handler({
          path: statusMd,
          edits: [
            { old_string: '# Status', new_string: '# Status Atualizado' },
            { old_string: '1. **WP-016 — rate limit:** amostra 10:00Z antiga.', new_string: '1. **WP-016:** ok.' },
            { old_string: '4. Revisar e integrar a PR GitOps DEV #9999.', new_string: '1. Integrada.' },
          ],
        }),
      (err) => {
        assert.match(err.message, /Edicao #2 \(edicoes #1\.\.#1 validadas OK\): old_string nao encontrado/);
        assert.match(err.message, /Edicao #3: old_string nao encontrado/);
        assert.match(err.message, /amostra 13:26Z registrou 30\/70 CRs/);
        assert.match(err.message, /Revisar e integrar a PR GitOps DEV #1101/);
        return true;
      },
    );

    // 3. Sugestao Levenshtein em edit_file quando há typo no caminho (ex.: microk8ks -> microk8s)
    const k8sDir = path.join(root, '00 - Microk8s');
    await mkdir(k8sDir, { recursive: true });
    const k8sScript = path.join(k8sDir, '4 - microk8s-args-apply.sh');
    await writeFile(k8sScript, '#!/usr/bin/env bash\necho ok\n', 'utf8');

    await assert.rejects(
      () =>
        tool('edit_file').handler({
          path: path.join(root, '00 - Microk8ks', '4 - microk8ks-args-apply.sh'),
          old_string: 'echo ok',
          new_string: 'echo done',
        }),
      (err) => {
        assert.match(err.message, /Caminho inexistente em edit_file/);
        assert.match(err.message, /Sugestao encontrada: .*00 - Microk8s\/4 - microk8s-args-apply\.sh/);
        return true;
      },
    );

    // 4. stat_path em lote e read_file com allow_missing=true (zero erro ENOENT)
    const statRes = await tool('stat_path').handler({
      paths: [
        k8sScript,
        path.join(root, 'AGENTS.md'),
        path.join(root, '00 - Microk8ks'),
      ],
    });
    const statText = textOf(statRes);
    assert.match(statText, /exists: true\ntype: file/);
    assert.match(statText, /AGENTS\.md\nexists: false\ntype: missing/);
    assert.match(statText, /suggestions: .*00 - Microk8s/);

    const allowMissingRes = await tool('read_file').handler({
      path: path.join(root, 'AGENTS.md'),
      allow_missing: true,
    });
    assert.match(textOf(allowMissingRes), /exists: false\nstatus: missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('v1.4.8: fallback de job unico em poll_command, normalizacao de contra-barras duplicadas em Bash/Markdown, resumo de edicoes validadas em multi_edit_file e sugestoes por tokens', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-dev-test-v148-'));
  try {
    // 1. Normalizacao automatica de contra-barras sobre-escapadas (\\\\\\n -> \\\n) em scripts Bash
    const shFile = path.join(root, 'validate-stack.sh');
    await writeFile(
      shFile,
      [
        '#!/usr/bin/env bash',
        'for f in \\',
        '  "$B/api-management-control-plane/15-release-proof.yml" \\',
        '  "$B/api-management/00-reconciler-rbac.yml"; do',
        '  echo "$f"',
        'done',
      ].join('\n'),
      'utf8',
    );

    await tool('multi_edit_file').handler({
      path: shFile,
      edits: [
        {
          old_string: '  "$B/api-management-control-plane/15-release-proof.yml" \\\\\n  "$B/api-management/00-reconciler-rbac.yml"; do',
          new_string:
            '  "$B/api-management-control-plane/15-release-proof.yml" \\\\\n  "$B/admin-api-management/00-admin.yml" \\\\\n  "$B/api-management/00-reconciler-rbac.yml"; do',
        },
      ],
    });
    const shUpdated = await readFile(shFile, 'utf8');
    assert.match(
      shUpdated,
      /"\$B\/api-management-control-plane\/15-release-proof\.yml" \\\n  "\$B\/admin-api-management\/00-admin\.yml" \\\n  "\$B\/api-management\/00-reconciler-rbac\.yml"; do/,
    );

    // 2. Resumo do lote em multi_edit_file quando a Edicao #1 falha mas Edicoes #2 e #3 sao validadas OK
    const docFile = path.join(root, 'STATUS.md');
    await writeFile(
      docFile,
      [
        '## CURRENT',
        '- Linha 1 original',
        '- Linha 2 valida',
        '- Linha 3 valida',
      ].join('\n'),
      'utf8',
    );

    await assert.rejects(
      () =>
        tool('multi_edit_file').handler({
          path: docFile,
          edits: [
            { old_string: '- Linha 1 divergente inexistente', new_string: '- Linha 1 nova' },
            { old_string: '- Linha 2 valida', new_string: '- Linha 2 atualizada' },
            { old_string: '- Linha 3 valida', new_string: '- Linha 3 atualizada' },
          ],
        }),
      /\[Resumo do lote: edicoes #2, #3 validadas OK/,
    );

    // 3. Sugestao encontrada por sobreposicao de tokens (ex.: wp017-api-restart-probe.log -> wp017-api-restart-20261111.tsv)
    const tsvFile = path.join(root, 'wp017-api-restart-20261111.tsv');
    await writeFile(tsvFile, 'ts\tstatus\n', 'utf8');
    await assert.rejects(
      () => tool('read_file').handler({ path: path.join(root, 'wp017-api-restart-probe.log') }),
      /Sugestao encontrada: .*wp017-api-restart-20261111\.tsv/,
    );

    // 4. poll_command: fallback automatico para o unico job running quando job_id e alucinado ou omitido (somente-leitura)
    const startRes = await tool('start_command').handler({
      command: 'printf "job_unico_ativo\\n" && sleep 15',
      cwd: root,
      wait_ms: 150,
    });
    const realJobId = textOf(startRes).match(/job_id: ([0-9a-f-]{36})/)?.[1];
    assert.ok(realJobId);

    const hallucinatedId = '4d8d90c2-8d84-43e6-91d6-40ef63e4b7a0';
    const pollHallucinated = await tool('poll_command').handler({
      job_id: hallucinatedId,
      wait_ms: 50,
      offset: 0,
    });
    const pollHallucinatedText = textOf(pollHallucinated);
    assert.match(pollHallucinatedText, new RegExp(`job_id: ${realJobId}`));
    assert.match(pollHallucinatedText, new RegExp(`job_id_autocorrected_from: ${hallucinatedId}`));
    assert.match(pollHallucinatedText, /job_unico_ativo/);

    const pollOmitted = await tool('poll_command').handler({
      wait_ms: 50,
      offset: 0,
    });
    assert.match(textOf(pollOmitted), new RegExp(`job_id: ${realJobId}`));

    // kill=true NUNCA deve fazer fallback para job com UUID completamente diferente
    await assert.rejects(
      () => tool('poll_command').handler({ job_id: hallucinatedId, kill: true }),
      /Job nao encontrado ou expirado/,
    );

    await tool('poll_command').handler({ job_id: realJobId, kill: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
