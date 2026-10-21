# Ferramentas MCP e Guia de Orientação de Uso

A versão `1.4.0` expõe **16 ferramentas**. O catálogo é definido em `src/tools.ts`, registrado dinamicamente pelo servidor em `src/server.ts` e acompanhado por instruções de protocolo (`instructions`) enviadas automaticamente no handshake `initialize`.

## Visão geral

| Ferramenta | Categoria | Efeito colateral | Quando usar |
|---|---|---|---|
| `find_files` | Descoberta de arquivos (`rg --files`) | Não | Localizar arquivos por nome, substring ou padrão glob (`*.tsx`, `sidebar`, `schema.prisma`) sem ler o conteúdo interno. |
| `search_code` | Busca nativa (`rg`) | Não | Localizar símbolos, imports, textos ou regex dentro de arquivos sem subir shell. |
| `read_file` | Leitura | Não | Ler 1 arquivo de texto (por linhas ou por caracteres), com bloqueio de binários. |
| `read_files` | Leitura em lote | Não | Ler de 2 a 20 arquivos na mesma chamada (economiza round-trips). |
| `list_directory` | Leitura | Não | Listar entradas de um diretório com paginação e profundidade opcional (`max_depth` 1 a 4). |
| `read_image` | Leitura multimodal | Não | Inspecionar PNG/JPEG/GIF/WebP como `ImageContent` MCP nativo. |
| `edit_file` | Filesystem | Sim | Fazer 1 substituição exata em um arquivo existente (com dicas contextuais se falhar). |
| `multi_edit_file` | Filesystem (atômico) | Sim | Fazer 2+ substituições disjuntas no mesmo arquivo em uma única chamada. |
| `write_file` | Filesystem | Sim | Criar arquivo novo ou reescrever o arquivo inteiro. |
| `move_file` | Filesystem | Sim | Mover ou renomear arquivo/diretório. |
| `make_directory` | Filesystem | Sim | Criar diretório recursivamente (`mkdir -p`). |
| `delete_path` | Filesystem | Sim, irreversível | Excluir arquivo ou diretório (`recursive=true` para árvores). |
| `run_command` | Shell síncrono | Sim | Comandos rápidos (< 15-30s) como `git status`, `git diff`, linters rápidos. |
| `read_command_output` | Leitura de artefato | Não | Paginar saídas grandes (> 30k chars) geradas por `run_command`, `start_command`, `search_code` ou `find_files`. |
| `start_command` | Shell assíncrono | Sim | Iniciar comandos longos (> 15-30s: builds, suítes E2E/Playwright, deploys, subagentes CLI) sem risco de timeout HTTP/Cloudflare. |
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
- **Diagnóstico de `ENOENT`**: se `path` não existir, retorna erro amigável indicando o diretório pai existente mais próximo e listando suas entradas imediatas.
- **Fallback automático de regex inválido**: se `fixed_strings` não for informado e `pattern` contiver metacaracteres desbalanceados (ex.: `"Inter("`, `"foo[bar"`), o `rg` retorna erro de sintaxe de regex (`exit_code: 2`) e o servidor **repete automaticamente a busca em modo literal (`--fixed-strings`)**, sinalizando `mode: fixed_strings_fallback (regex invalido tratado como texto literal)`.
- **Zero ocorrências sem erro**: quando nada é encontrado (`rg` exit code 1), retorna `exit_code: 0` e `matches: 0`.

**Boas práticas em `search_code`**:
1. Sempre informe `path` apontando para o repositório ou subpasta relevante (ex.: `~/projetos/meu-app/src`), evitando varrer o diretório home inteiro.
2. Ative `fixed_strings=true` sempre que buscar um trecho literal com `()`, `[]`, `{}` ou `.`.

---

### `find_files`

Busca arquivos pelo nome ou caminho relativo usando `ripgrep --files` (muito mais rápido que `find` e já ignorando `node_modules`, `.git`, `.next`, `dist`, `build`, `coverage` e `/root/repos/work` por padrão).

Entradas:

| Campo | Tipo | Padrão | Limite |
|---|---|---:|---:|
| `path` | string | home do usuário | — |
| `pattern` | string | — | filtro substring ou glob; aceita múltiplos padrões separados por `\|` (OR) |
| `globs` | `string[]` | — | até 50 globs (ex.: `["*.tsx", "!*.test.tsx"]`) |
| `max_depth` | inteiro | — | `1` a `10` (profundidade máxima de subdiretórios) |
| `max_results` | inteiro | `200` | `1` a `2000` |

Comportamento:

- Lista caminhos relativos a `path` em ordem alfabética;
- Informa `matched_files`, `returned_files`, `has_more` e os caminhos encontrados;
- Se `path` não existir, retorna erro com dica listando o diretório pai existente mais próximo.

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

Inicia um comando shell em background e aguarda até `wait_ms` (padrão `5000` ms, máximo `30000` ms).

Entradas:

| Campo | Tipo | Padrão | Limite |
|---|---|---:|---:|
| `command` | string | obrigatório | — |
| `cwd` | string | home do usuário | — |
| `wait_ms` | inteiro | `5000` | `0` a `30000` |
| `timeout_ms` | inteiro | `600000` | `1000` a `1800000` |

Comportamento:

- Se o comando terminar dentro de `wait_ms`, já devolve `status: exited` e o resultado completo;
- Se continuar rodando, devolve `job_id`, `status: running`, `next_offset` e um `poll_hint` orientando o próximo `poll_command`;
- Mantém histórico de até 200 jobs em memória com retenção de 2 horas após o término.

---

### `poll_command`

Consulta o andamento, lê novas saídas ou encerra um job iniciado por `start_command`.

Entradas:

| Campo | Tipo | Padrão | Limite |
|---|---|---:|---:|
| `job_id` | UUID | obrigatório | — |
| `wait_ms` | inteiro | `5000` | `0` a `30000` |
| `offset` | inteiro | `0` | >= 0 |
| `limit` | inteiro | `30000` | `1` a `30000` |
| `kill` | boolean | `false` | — |

**Dica crítica de performance (`offset=next_offset`)**:
Ao acompanhar um job que ainda está `running`, passe `offset` igual ao `next_offset` retornado na chamada anterior. Isso lê **apenas o stdout novo** produzido desde a última consulta, evitando reenviar todo o log acumulado a cada poll.

---

### `read_image`

Lê uma imagem do filesystem (PNG, JPEG, GIF, WebP) e retorna um bloco `ImageContent` MCP nativo junto de metadata (path absoluto, MIME, bytes, dimensões quando detectáveis e SHA-256). Limite padrão: `MCP_MAX_IMAGE_BYTES` (10 MiB).

---

### `list_directory`

Lista arquivos, diretórios e links simbólicos em ordem alfabética com paginação (`path`, `offset` padrão `0`, `limit` padrão `200`, máx `1000`, `max_depth` padrão `1`, máx `4`). Quando `max_depth > 1`, percorre subdiretórios ignorando automaticamente `node_modules`, `.git`, `.next`, `dist`, `build` e `coverage`.

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
