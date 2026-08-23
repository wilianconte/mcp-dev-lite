# Ferramentas MCP

A versão `1.2.0` expõe 10 ferramentas. O catálogo é definido em `src/tools.ts` e registrado dinamicamente pelo servidor.

## Visão geral

| Ferramenta | Categoria | Efeito colateral |
|---|---|---|
| `run_command` | Shell | Sim |
| `read_command_output` | Leitura | Não |
| `read_file` | Leitura | Não |
| `read_image` | Leitura multimodal | Não |
| `write_file` | Filesystem | Sim |
| `edit_file` | Filesystem | Sim |
| `list_directory` | Leitura | Não |
| `move_file` | Filesystem | Sim |
| `make_directory` | Filesystem | Sim |
| `delete_path` | Filesystem | Sim, irreversível |

## Convenções de path

As ferramentas de filesystem aceitam:

- caminhos absolutos;
- caminhos relativos, resolvidos a partir do `cwd` do processo;
- `~` e caminhos iniciados por `~/`, resolvidos para o home do usuário do processo.

Não existe restrição de diretório. As permissões do usuário Linux do serviço são a fronteira efetiva de acesso.

## `run_command`

Executa um comando por `/bin/bash -c`.

Entradas:

| Campo | Tipo | Padrão | Limite |
|---|---|---:|---:|
| `command` | string | obrigatório | — |
| `cwd` | string | home do usuário | — |
| `timeout_ms` | inteiro | `120000` | `600000` |

Comportamento:

- captura stdout e stderr;
- cria grupo de processos próprio em plataformas Unix;
- no timeout, encerra shell e descendentes;
- limita o volume capturado pelo buffer configurável;
- devolve `exit_code` junto do conteúdo.

Configuração relacionada:

- `MCP_COMMAND_MAX_BUFFER_BYTES`: padrão de 50 MiB.

Se a resposta completa ultrapassar aproximadamente 30 mil caracteres, o servidor devolve uma prévia com início e fim e grava o conteúdo integral temporariamente. O resultado inclui um `artifact_id` para leitura posterior.

## `read_command_output`

Lê uma página de uma saída grande preservada por `run_command`.

Entradas:

| Campo | Tipo | Padrão | Limite |
|---|---|---:|---:|
| `artifact_id` | UUID | obrigatório | — |
| `offset` | inteiro | `0` | >= 0 |
| `limit` | inteiro | `30000` | `30000` |

A resposta informa `total_chars`, `total_bytes`, `has_more` e `next_offset`.

Artefatos expiram após 1 hora e o armazenamento mantém no máximo 50 arquivos válidos.

## `read_file`

Lê arquivos de texto com duas estratégias de paginação mutuamente exclusivas.

### Por linhas

- `offset`: linha inicial; base 1, com `0` aceito como início por compatibilidade;
- `limit`: quantidade de linhas.

A resposta informa faixa retornada, total de linhas, tamanho do arquivo e próximo offset.

### Por caracteres

- `char_offset`: posição inicial, base 0;
- `char_limit`: quantidade de caracteres, máximo de 30 mil.

Use esse modo para JSON minificado, bundles, logs com linhas muito longas e outros conteúdos em que paginação por linha não ajuda.

Não misture parâmetros de linha e de caracteres na mesma chamada.

## `read_image`

Lê uma imagem do filesystem e retorna um bloco `ImageContent` MCP nativo.

Formatos aceitos:

- PNG;
- JPEG;
- GIF;
- WebP.

Metadata devolvida:

- path absoluto;
- MIME type;
- bytes;
- dimensões quando detectáveis;
- SHA-256.

Configuração relacionada:

- `MCP_MAX_IMAGE_BYTES`: padrão de 10 MiB.

PNG e GIF têm dimensões extraídas pelo código atual. JPEG e WebP são reconhecidos, mas a implementação atual não extrai largura/altura desses formatos.

### Fluxo recomendado para UX

1. gere o screenshot no projeto, por exemplo com Playwright;
2. localize o arquivo;
3. chame `read_image` diretamente;
4. faça a análise visual sobre o conteúdo MCP retornado.

Evite imprimir base64 por `run_command`.

## `write_file`

Cria ou sobrescreve um arquivo de texto UTF-8.

Entradas:

- `path`;
- `content`.

Diretórios pais são criados automaticamente.

## `edit_file`

Faz substituição textual exata.

Entradas:

- `path`;
- `old_string`;
- `new_string`;
- `replace_all`, padrão `false`.

Se `old_string` não existir, a operação falha. Se existir mais de uma vez e `replace_all` estiver falso, a operação também falha para evitar alteração ambígua.

## `list_directory`

Lista arquivos, diretórios e links simbolicamente, em ordem alfabética.

Entradas:

| Campo | Tipo | Padrão | Limite |
|---|---|---:|---:|
| `path` | string | home do usuário | — |
| `offset` | inteiro | `0` | >= 0 |
| `limit` | inteiro | `200` | `1000` |

A resposta informa `total`, `returned`, `has_more` e `next_offset`.

## `move_file`

Move ou renomeia arquivo/diretório com `fs.rename`.

Entradas:

- `source`;
- `destination`.

O diretório pai do destino é criado automaticamente.

## `make_directory`

Cria um diretório recursivamente, equivalente a `mkdir -p`.

Entrada:

- `path`.

## `delete_path`

Exclui arquivo ou diretório.

Entradas:

- `path`;
- `recursive`, padrão `false`.

A operação é irreversível. Para diretórios não vazios, `recursive=true` remove toda a árvore.

## Padrões de uso

### Inspecionar um projeto grande

1. `list_directory` para mapear o nível atual;
2. `read_file` por linhas para arquivos-fonte;
3. `read_file` por caracteres para arquivos minificados;
4. `run_command` para buscas, builds e testes;
5. `read_command_output` se a saída ficar grande.

### Fazer uma alteração segura

1. leia o arquivo relevante;
2. prefira `edit_file` para alteração cirúrgica;
3. use `write_file` quando o conteúdo completo realmente precisar ser refeito;
4. rode typecheck/testes com `run_command`;
5. confira o diff com `git diff`.

### Analisar interface

1. rode a aplicação/teste visual;
2. capture screenshots;
3. use `read_image` em cada screenshot relevante;
4. compare o estado visual com os fluxos e requisitos.
