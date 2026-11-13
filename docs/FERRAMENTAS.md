# Ferramentas MCP e Guia de Orientação de Uso

A versão `1.4.9` expõe **17 ferramentas**. O catálogo é definido em `src/tools.ts`, registrado dinamicamente pelo servidor em `src/server.ts` e acompanhado por instruções de protocolo (`instructions`) enviadas automaticamente no handshake `initialize`.

## Visão geral

| Ferramenta | Categoria | Efeito colateral | Quando usar |
|---|---|---|---|
| `stat_path` | Metadados e existência | Não | Verificar existência, tipo (`file`, `directory`, `symlink`, `missing`), tamanho e `mtime` de 1 a 30 caminhos sem risco de erro `ENOENT`. |
| `find_files` | Descoberta de arquivos/worktrees (`rg --files`) | Não | Localizar arquivos ou diretórios de worktree por nome, substring ou padrão glob (`*.tsx`, `sidebar`, `.sdd/ledger.md`) sem ler o conteúdo interno. |
| `search_code` | Busca nativa (`rg`) | Não | Localizar símbolos, imports, textos, checkboxes (`[ ]`) ou regex dentro de arquivos sem subir shell. |
| `read_file` | Leitura (com cache LRU zero-stale) | Não | Ler 1 arquivo de texto (por linhas ou por caracteres), com `allow_missing=true` opcional e bloqueio de binários. |
| `read_files` | Leitura em lote | Não | Ler de 2 a 20 arquivos (ou múltiplas faixas `offset`/`limit` do mesmo arquivo) na mesma chamada. |
| `list_directory` | Leitura | Não | Listar entradas de um diretório com paginação, filtro `pattern` e profundidade opcional (`max_depth` 1 a 4). |
| `read_image` | Leitura multimodal | Não | Inspecionar PNG/JPEG/GIF/WebP como `ImageContent` MCP nativo. |
| `edit_file` | Filesystem | Sim | Fazer 1 substituição exata em um arquivo existente (com normalização em 5 passos e dicas contextuais se falhar). |
| `multi_edit_file` | Filesystem (atômico) | Sim | Fazer 2+ substituições no mesmo arquivo em uma única chamada (com desambiguação *batch-aware* e validação multi-bloco). |
| `write_file` | Filesystem | Sim | Criar arquivo novo ou reescrever o arquivo inteiro. |
| `move_file` | Filesystem | Sim | Mover ou renomear arquivo/diretório. |
| `make_directory` | Filesystem | Sim | Criar diretório recursivamente (`mkdir -p`). |
| `delete_path` | Filesystem | Sim, irreversível | Excluir arquivo ou diretório (`recursive=true` para árvores não vazias). |
| `run_command` | Shell síncrono | Sim | Comandos rápidos (< 15-30s) como `git status`, `git diff`, linters rápidos. |
| `read_command_output` | Leitura de artefato | Não | Paginar saídas grandes (> 30k chars) geradas por `run_command`, `start_command`, `search_code` ou `find_files`. |
| `start_command` | Shell assíncrono | Sim | Iniciar comandos longos (> 15-30s: builds, suítes E2E/Playwright, deploys, subagentes CLI) com coalescência automática de comandos idênticos em execução. |
| `poll_command` | Shell assíncrono | Não (exceto `kill=true`) | Consultar status/stdout incremental (`offset=next_offset`) ou encerrar job iniciado por `start_command`. |

---

## Matriz de Decisão Rápida (Qual ferramenta escolher?)

Para minimizar latência, evitar timeouts de proxy (Cloudflare/HTTP ~100s) e reduzir consumo de tokens:

| Necessidade do Agente | Ferramenta Recomendada | Anti-padrão (Evitar) |
|---|---|---|
| Descobrir onde estão arquivos por nome, extensão ou caminho | `find_files` (ex.: `pattern='sidebar'`, `pattern='*.spec.ts'`) ou `list_directory(max_depth=3)` | `run_command` com `find`, `ls -R` ou `search_code` procurando nome de arquivo |
| Procurar onde uma função, componente, rota ou string é usada | `search_code` (com `path` do projeto e `fixed_strings=true` quando literal) | `run_command` com `grep -rn` ou `rg` via bash |
| Ler 2 ou mais arquivos relacionados (ex.: `package.json` + `tsconfig.json` + rotas) | `read_files` (até 20 arquivos em paralelo) | Múltiplas chamadas sequenciais a `read_file` ou `cat`/`head`/`sed` via `run_command` |
| Aplicar vários ajustes no mesmo arquivo | `multi_edit_file` (atômico: se um bloco falhar, nada é salvo) | Várias chamadas seguidas a `edit_file` no mesmo arquivo |
| Rodar build pesado, `npm install`, `playwright test`, pipelines `&&` ou subagentes CLI (`agy`) (> 15-30s) | `start_command` + `poll_command` (usando `offset=next_offset`) | `run_command` com comando longo ou `nohup ... > /tmp/log 2>&1 &` manual |
| Inspecionar screenshot ou evidência visual | `read_image` | Converter imagem para `base64` via `run_command` |

---

## Convenções de path

As ferramentas de filesystem e busca aceitam:

- caminhos absolutos;
- caminhos relativos, resolvidos a partir do `cwd` do processo;
- `~` e caminhos iniciados por `~/`, resolvidos para o home do usuário do processo.

Não existe restrição artificial de diretório: as permissões do usuário Linux do serviço são a fronteira efetiva de acesso.

---

## Catálogo Detalhado

### `search_code`

Busca padrões em arquivos de código usando `ripgrep` (`rg`) nativo com números de linha, sem invocar shell.

Entradas:

| Campo | Tipo | Padrão | Limite |
|---|---|---:|---:|
| `pattern` | string | obrigatório | >= 1 char |
| `path` | string | home do usuário | — |
| `globs` | `string[]` | — | até 50 globs |
| `ignore_case` | boolean | `false` | — |
| `fixed_strings` | boolean | `false` | — |
| `context_lines` | inteiro | `0` | `0` a `10` |
| `max_results` | inteiro | `200` | `1` a `1000` |

Comportamento e salvaguardas:

- **Exclusão automática de diretórios pesados**: exclui por padrão `node_modules`, `.git`, `.next`, `dist`, `build`, `coverage` e `/root/repos/work`, a menos que `path` ou `globs` apontem explicitamente para um deles.
- **Extração automática de glob em `path`**: se `path` contiver curingas ao final (ex.: `/dir/scripts/crm-p1-*.test.mjs`), separa automaticamente o diretório base existente (`/dir/scripts`) e aplica o sufixo (`crm-p1-*.test.mjs`) como filtro `--glob`, evitando falha por `ENOENT` (também suportado em `find_files` e `list_directory`).
- **Diagnóstico de `ENOENT`**: se `path` não existir, retorna erro amigável indicando o diretório pai existente mais próximo, sugestões estruturais (`services/`, `packages/`, `apps/`, etc.) e entradas similares ranqueadas.
- **Fallback automático de regex inválido e auto-detecção de colchetes literais**: se `fixed_strings` não for informado e `pattern` contiver checkboxes literais (`[ ]`, `[]`) ou metacaracteres desbalanceados (ex.: `"Inter("`, `"foo[bar"`), o servidor usa modo literal (`--fixed-strings`) automaticamente (`fixed_strings_auto` / `fixed_strings_fallback`).
- **Zero ocorrências sem erro**: quando nada é encontrado (`rg` exit code 1), retorna `exit_code: 0` e `matches: 0`.

**Boas práticas em `search_code`**:
1. Sempre informe `path` apontando para o repositório ou subpasta relevante (ex.: `~/projetos/meu-app/src`), evitando varrer o diretório home inteiro.
2. Ative `fixed_strings=true` sempre que buscar um trecho literal com `()`, `[]`, `{}` ou `.`.

---

### `stat_path`

Verifica rapidamente a existência e metadados (`exists`, `type`: `file`/`directory`/`symlink`/`missing`, `size_bytes`, `mtime`) de 1 a 30 caminhos em uma única chamada, sem gerar erro `ENOENT`.

Entradas:
- `paths`: lista de 1 a 30 caminhos absolutos, relativos ou com `~`.

Quando um caminho não existe (`exists: false`), retorna `suggestions` com caminhos irmãos de nome similar (distância de edição Levenshtein ou sobreposição de tokens).

---

### `find_files`

Busca arquivos ou diretórios de worktree pelo nome ou caminho relativo usando `ripgrep --files` (muito mais rápido que `find` e já ignorando `node_modules`, `.git`, `.next`, `dist`, `build`, `coverage` e `/root/repos/work` por padrão).

Entradas:

| Campo | Tipo | Padrão | Limite |
|---|---|---:|---:|
| `path` | string | home do usuário | — |
| `pattern` | string | — | filtro substring ou glob; aceita múltiplos padrões separados por `\|` (OR) |
| `globs` | `string[]` | — | até 50 globs (ex.: `["*.tsx", "!*.test.tsx"]`) |
| `max_depth` | inteiro | — | `1` a `10` (profundidade máxima de subdiretórios) |
| `max_results` | inteiro | `200` | `1` a `2000` |

Comportamento:

- Usa o índice de diretórios *zero-stale* (`WorktreeDirectoryIndexCache`) para listar diretórios de topo correspondentes (`matching_directories`) e podar subdiretórios em `/root/repos/work` quando o `pattern` filtra worktrees específicas;
- Faz fallback automático com `--no-ignore-vcs` (mantendo exclusão de diretórios pesados) quando `returned_files === 0` ou quando o padrão busca `.sdd`, `.superpowers` ou `ledger.md`;
- Lista caminhos em ordem alfabética, informando `matching_directories`, `returned_files`, `total_files` e `truncated`.

---

### `read_file`

Lê 1 arquivo de texto UTF-8 com proteção contra arquivos binários e duas estratégias de paginação mutuamente exclusivas:

#### Salvaguardas
- **Proteção contra binários**: inspeciona os primeiros 8 KiB à procura de bytes nulos (`0x00`). Caso detecte arquivo binário (ou extensão de imagem), rejeita a leitura orientando a usar `read_image` para imagens (`PNG`, `JPEG`, `GIF`, `WebP`) ou ferramentas específicas.
- **Limite de tamanho**: arquivos acima de `MCP_MAX_TEXT_FILE_BYTES` (padrão 10 MiB) são rejeitados para proteger a memória e o contexto; use `search_code` para filtrar logs/dumps gigantes.

#### Por linhas
- `offset`: linha inicial (base 1; `0` é aceito como início por compatibilidade);
- `limit`: quantidade máxima de linhas.

A resposta informa faixa retornada, total de linhas, tamanho do arquivo, `has_more` e `next_offset`.

#### Por caracteres
- `char_offset`: posição inicial (base 0);
- `char_limit`: quantidade de caracteres, máximo de `30000`.

Use o modo por caracteres para JSON minificado, bundles, logs com linhas muito longas e outros conteúdos em que paginação por linha não ajuda. Não misture parâmetros de linha e de caracteres na mesma chamada.

---

### `read_files`

Lê múltiplos arquivos de texto UTF-8 (de 1 a 20 arquivos) em uma única chamada.

Entradas:

- `files`: lista de 1 a 20 objetos `{ path, offset?, limit? }`.

Comportamento:

- Lê todos os arquivos em paralelo (aplicando a mesma proteção contra binários e limite `MCP_MAX_TEXT_FILE_BYTES` de `read_file`);
- Se um dos arquivos não existir ou falhar, retorna `status: error` apenas naquele item sem abortar a leitura dos demais;
- Retorna cada arquivo com cabeçalho `[i/total]`, `path`, `size_bytes`, `lines`, `has_more` e `next_offset`.

---

### `edit_file`

Faz uma substituição textual exata em um arquivo existente.

Entradas:

- `path`;
- `old_string` (não vazio; deve coincidir exatamente, incluindo indentação);
- `new_string`;
- `replace_all` (padrão `false`).

Diagnóstico contextual em falhas:
- Se `old_string` não existir exatamente como informado, o erro busca automaticamente a primeira linha não vazia de `old_string` (case-insensitive) no arquivo e exibe um trecho numerado (`linha: conteúdo`) ao redor da linha semelhante para correção imediata sem novo `read_file`.
- Se `old_string` aparecer mais de uma vez e `replace_all` estiver `false`, a operação falha informando os **números das linhas (1-based)** onde as ocorrências começam.

---

### `multi_edit_file`

Aplica múltiplas substituições exatas (`old_string` -> `new_string`) em sequência no **mesmo arquivo**, em uma única chamada atômica.

Entradas:

- `path`;
- `edits`: lista de 1 a 50 operações `{ old_string, new_string, replace_all? }`.

Comportamento:

- Todas as edições são validadas e aplicadas em memória;
- Se qualquer item de `edits` falhar (texto não encontrado ou múltiplas ocorrências sem `replace_all=true`), **nenhuma alteração é gravada no disco** e o erro indica exatamente o índice da edição (`Edicao #N`) com o mesmo diagnóstico contextual de linhas de `edit_file`;
- Usa substituição literal segura (sequências como `$&` ou `$$` em `new_string` nunca são interpretadas como padrões especiais de `String.prototype.replace`).

---

### `write_file`

Cria um arquivo novo ou sobrescreve integralmente um arquivo de texto UTF-8.

Entradas:

- `path`;
- `content`.

Diretórios pais são criados automaticamente. Para arquivos existentes nos quais apenas trechos mudam, prefira `edit_file` ou `multi_edit_file`.

---

### `run_command`

Executa um comando síncrono por `/bin/bash -c`. Ideal para comandos rápidos (< 15-30s).

Entradas:

| Campo | Tipo | Padrão | Limite |
|---|---|---:|---:|
| `command` | string | obrigatório | — |
| `cwd` | string | home do usuário | — |
| `timeout_ms` | inteiro | `120000` | `600000` |

Comportamento:

- captura stdout e stderr;
- cria grupo de processos próprio em plataformas Unix;
- no timeout, encerra shell e descendentes (`SIGTERM` seguido de `SIGKILL`);
- limita o volume capturado por `MCP_COMMAND_MAX_BUFFER_BYTES` (padrão 50 MiB);
- se a saída ultrapassar ~30 mil caracteres, devolve prévia com início + fim e salva a saída integral temporariamente com um `artifact_id` para leitura em `read_command_output`.

---

### `read_command_output`

Lê uma página de uma saída grande preservada por `run_command`.

Entradas:

| Campo | Tipo | Padrão | Limite |
|---|---|---:|---:|
| `artifact_id` | UUID | obrigatório | — |
| `offset` | inteiro | `0` | >= 0 |
| `limit` | inteiro | `30000` | `30000` |

A resposta informa `total_chars`, `total_bytes`, `has_more` e `next_offset`. Artefatos expiram após 1 hora (máximo de 50 artefatos).

---

### `start_command`

Inicia um comando shell em background e aguarda até `wait_ms` (padrão `10000` ms, máximo `120000` ms).

Entradas:

| Campo | Tipo | Padrão | Limite |
|---|---|---:|---:|
| `command` | string | obrigatório | — |
| `cwd` | string | home do usuário | — |
| `wait_ms` | inteiro | `10000` | `0` a `120000` |
| `timeout_ms` | inteiro | `1200000` | `1` a `3600000` |

Comportamento:

- Se o comando terminar dentro de `wait_ms` (retornando no exato milissegundo em que o processo encerrar), já devolve `status: completed` e o resultado completo;
- Se continuar rodando, devolve `job_id`, `status: running`, `process_alive: true`, `next_offset` e um `poll_hint` adaptativo orientando o próximo `poll_command`;
- Finaliza imediatamente após o `exit` do processo `/bin/bash -c` (com janela de drenagem de `250ms` para pipes), mesmo que processos netos em background herdem descritores `stdout`/`stderr`;
- Persiste snapshots em disco (`/tmp/mcp-dev-agent-jobs/<job_id>.json`) além do cache em memória (até 200 jobs com retenção de 2 horas), sobrevivendo a reinicializações do serviço.

---

### `poll_command`

Consulta o andamento, lê novas saídas incrementais (`stdout` e `stderr`) ou encerra um job iniciado por `start_command`.

Entradas:

| Campo | Tipo | Padrão | Limite |
|---|---|---:|---:|
| `job_id` | UUID | obrigatório | — |
| `wait_ms` | inteiro | `60000` | `0` a `180000` |
| `offset` | inteiro | `0` | >= 0 |
| `stderr_offset` | inteiro | automático | >= 0 |
| `kill` | boolean | `false` | — |

**Dicas críticas de performance (`offset=next_offset`, `wait_ms` longo e compactação de `gh run watch`)**:
- Ao acompanhar um job que ainda está `running`, passe `offset` igual ao `next_offset` retornado na chamada anterior e `wait_ms` entre `60000` e `180000` (use `120000` a `180000` para `agy`, `vitest`, `playwright`, `gh run watch` e builds longos — se o processo concluir antes, `poll_command` retorna imediatamente). Isso lê **apenas o `stdout` e o `stderr` novos** produzidos desde a última consulta, evitando reenviar logs acumulados a cada poll;
- **Inspeção automática de arquivos redirecionados (`> /caminho/arquivo`) e detecção de `stream-json`**: quando o comando redireciona `stdout`/`stderr` para arquivos no disco (ex.: `agy ... > stream.jsonl 2> stderr.log`), `start_command` e `poll_command` informam automaticamente `redirected_output_files` (com tamanho atualizado em bytes), `redirected_output_preview` (cauda recente do arquivo) e `stream_json_status: result_ready` assim que um evento final `{"event":"result"}` é gravado, liberando o `poll_command` antecipadamente sem aguardar o fim do timeout;
- Saídas repetitivas de `gh run watch` (`Refreshing run status every ... seconds`) têm seus frames intermediários automaticamente colapsados para preservar apenas o snapshot mais recente sem alterar `next_offset`.

---

### `read_image`

Lê uma imagem do filesystem (PNG, JPEG, GIF, WebP) e retorna um bloco `ImageContent` MCP nativo junto de metadata (path absoluto, MIME, bytes, dimensões quando detectáveis e SHA-256). Limite padrão: `MCP_MAX_IMAGE_BYTES` (10 MiB).

---

### `list_directory`

Lista arquivos, diretórios e links simbólicos em ordem alfabética com paginação (`path`, `pattern` opcional para filtrar por substring/glob com `|`, `offset` padrão `0`, `limit` padrão `200`, máx `1000`, `max_depth` padrão `1`, máx `4`). Quando `max_depth > 1`, percorre subdiretórios ignorando automaticamente `node_modules`, `.git`, `.next`, `dist`, `build` e `coverage`.

### `move_file`

Move ou renomeia arquivo/diretório (`source`, `destination`), criando diretórios pais do destino automaticamente.

### `make_directory`

Cria diretório recursivamente (`path`), equivalente a `mkdir -p`.

### `delete_path`

Exclui arquivo ou diretório (`path`, `recursive` padrão `false`). Operação irreversível.

---

## Fluxos Recomendados

### 1. Explorar e entender um repositório rapidamente
1. `list_directory` (com `max_depth=2` ou `max_depth=3`) para mapear a árvore do projeto de uma só vez;
2. `find_files` para localizar rapidamente caminhos de arquivos por nome ou glob;
3. `search_code` informando `path` do repositório (e `fixed_strings=true` quando buscar nomes exatos) para achar definições e referências;
4. `read_files` para carregar de uma só vez os 3 a 10 arquivos relevantes encontrados.

### 2. Realizar alterações seguras em código
1. Leia o trecho exato com `read_file` ou `read_files`;
2. Use `edit_file` (1 mudança) ou `multi_edit_file` (várias mudanças no mesmo arquivo);
3. Valide com `run_command` (se o typecheck/teste for rápido) ou `start_command` + `poll_command` (se o build/teste demorar mais de 15-30s).

### 3. Auditoria visual / UX
1. Gere os screenshots da aplicação (ex.: Playwright);
2. Chame `read_image` diretamente sobre os arquivos `.png`/`.webp` gerados.

---

## Painel `/logs` e Acompanhamento de KPIs (`/logs/kpis`)

O painel em tempo real em `/logs` possui 4 abas:
1. **Transações em Tempo Real**: stream SSE de todas as chamadas e eventos com expansão de argumentos e preview.
2. **Conexões e Sessões MCP**: sessões ativas/encerradas, cliente, IP e contadores.
3. **Alertas**: watchdog configurável de inatividade com alerta sonoro via Web Audio API e histórico de incidentes.
4. **KPI's (`#kpis` / `GET /logs/kpis`)**:
   - **Termômetro de Massa Crítica**: acompanha os 4 pilares para reavaliação estatística (`>= 1.500` chamadas totais, `>= 200` edições `edit_file` + `multi_edit_file`, `>= 80` chamadas `poll_command`, ou critério híbrido de `7 dias` com mínimo de `1.000` chamadas), classificando em `COLETA_INICIAL`, `PRELIMINAR` (`>= 500` calls, `>= 75` edições, `>= 30` polls) ou `PRONTA`.
   - **6 Scorecards Qualitativos com comparativo de baseline (`v1.4.9` vs `v1.4.8`)**: Confiabilidade Global (`>= 99%`), Qualidade de Edição e Auto-Recuperação sem `read_file` (*Self-Heal*), Eficiência de Jobs e Polling (`wait_ms >= 60s`), Higiene de Ambiente e Ferramentas Nativas (`NVM manual = 0`), Economia de Contexto e Batching, e Latência Nativa Local (`p50`/`p95` + telemetria de hits dos Caches Zero-Stale).
   - **Tabela por Ferramenta e Diagnóstico de Erros/Anti-Padrões**: detalha volume, taxas de erro, latências `p50/p95`, payload médio e assinaturas residuais.
