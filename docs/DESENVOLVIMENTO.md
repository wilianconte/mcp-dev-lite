# Desenvolvimento

## Stack

- Node.js 20+;
- TypeScript;
- ESM (`"type": "module"`);
- Express;
- `@modelcontextprotocol/sdk`;
- Zod;
- `node:test` para testes automatizados.

O TypeScript está configurado com `strict: true`.

## Estrutura do repositório

```text
mcp-dev/
|-- src/
|   |-- server.ts         # HTTP, auth do /mcp, sessões e registro das tools
|   |-- oauth.ts          # provider OAuth 2.1
|   |-- tools.ts          # catálogo e handlers das 16 ferramentas MCP
|   |-- audit.ts          # auditoria estruturada, rotação por tamanho e redaction de segredos
|   |-- monitor.ts        # rastreamento de sessões/transações e painel /logs (SSE)
|   `-- output-store.ts   # paginação persistida de saídas grandes
|-- test/
|   |-- audit.test.mjs
|   |-- server.test.mjs   # integração MCP/auth/OAuth/proxy/auditoria
|   `-- tools.test.mjs
|-- docs/
|-- deploy/
|-- scripts/
|-- data/                 # estado local; ignorado pelo Git
|-- dist/                 # build; ignorado pelo Git
|-- package.json
`-- tsconfig.json
```

## Scripts

| Comando | Finalidade |
|---|---|
| `npm run dev` | Executa `src/server.ts` com reload via `tsx watch`. |
| `npm run typecheck` | Valida tipos sem gerar `dist`. |
| `npm run build` | Compila `src` para `dist`. |
| `npm test` | Compila e roda `node --test test/*.test.mjs`. |
| `npm start` | Executa `dist/server.js`. |

## Workflow recomendado

Antes de alterar:

```bash
git status --short --branch
npm run typecheck
npm test
```

Depois da alteração:

```bash
npm run typecheck
npm test
git diff --check
git diff
```

Não considere somente o build como validação: mudanças no comportamento das ferramentas devem receber teste automatizado.

## Adicionando uma ferramenta MCP

1. adicione um item em `tools` em `src/tools.ts`;
2. defina `name`, `title`, `description` e schema Zod;
3. implemente o handler retornando `Promise<CallToolResult>`;
4. prefira resultado textual via helper `textResult` quando não houver conteúdo multimodal;
5. adicione teste em `test/`;
6. atualize [`FERRAMENTAS.md`](./FERRAMENTAS.md);
7. se a ferramenta alterar risco ou operação, atualize também [`SEGURANCA.md`](./SEGURANCA.md) e [`OPERACAO.md`](./OPERACAO.md).

O servidor registra automaticamente todos os itens do array `tools`; não é necessário duplicar o registro em `server.ts`.

## Resultados multimodais

Handlers não precisam retornar apenas texto. O contrato interno usa `CallToolResult` do SDK MCP.

Para novos tipos de artefato:

- use os tipos de conteúdo suportados pelo SDK;
- evite codificar dados binários dentro de texto quando existir um tipo MCP apropriado;
- mantenha metadata textual pequena e útil;
- imponha limites de tamanho explícitos.

`read_image` é a referência atual desse padrão.

## Saídas grandes

Não remova a paginação sem avaliar impacto no contexto do cliente.

O padrão atual é:

- preview textual de aproximadamente 30 mil caracteres;
- preservação do início e do fim da saída;
- armazenamento temporário da saída integral;
- leitura posterior por `artifact_id`.

Ao alterar esse fluxo, cubra pelo menos:

- expiração;
- permissões dos arquivos temporários;
- limites de tamanho;
- paginação sem perda;
- limpeza de artefatos.

## Execução de comandos

Mudanças em `run_command` exigem atenção especial a:

- timeout;
- processos descendentes;
- buffer de stdout/stderr;
- sinais Unix;
- códigos de saída;
- comandos que geram grande volume de output.

Já existe teste para encerramento do grupo de processos após timeout.

## OAuth

Mudanças em `src/oauth.ts` devem ser avaliadas junto ao comportamento do SDK MCP instalado. O SDK atualmente executa a validação local de PKCE usando o challenge retornado por `challengeForAuthorizationCode` antes da troca do authorization code.

Ao alterar OAuth, teste no mínimo:

- DCR;
- autorização aprovada e negada;
- PKCE inválido;
- authorization code de uso único;
- redirect URI divergente;
- expiração;
- refresh com rotação;
- revogação;
- restart do processo e persistência do estado esperado.

A suíte de integração cobre hoje DCR, autorização aprovada, PKCE válido, refresh com rotação, rejeição do refresh antigo e revogação. Casos negativos adicionais — como PKCE inválido, redirect URI divergente, expiração e persistência após restart — continuam bons candidatos para ampliação incremental.

## Versionamento

A versão está presente em mais de um ponto:

- `package.json`;
- metadata criada em `src/server.ts`.

Enquanto essa duplicação existir, mantenha os dois valores sincronizados.

Uma evolução recomendada é eliminar a duplicação e obter a versão de uma única fonte de verdade.

## Documentação como parte da mudança

Use esta regra:

| Alteração | Documento a revisar |
|---|---|
| Nova tool ou mudança de schema | `FERRAMENTAS.md` |
| Nova variável de ambiente | `.env.example` e `OPERACAO.md` |
| Mudança de módulos/fluxo | `ARQUITETURA.md` |
| Mudança de auth/permissões | `SEGURANCA.md` |
| Mudança de deploy | `DEPLOY-CLOUDFLARE.md` / `OPERACAO.md` |
| Nova limitação conhecida | `AVALIACAO-TECNICA.md` |

## Critério de pronto

- [ ] typecheck verde;
- [ ] build verde;
- [ ] testes existentes verdes;
- [ ] novo comportamento coberto por teste quando aplicável;
- [ ] `git diff --check` sem erros;
- [ ] sem segredo adicionado ao Git;
- [ ] documentação proprietária do comportamento atualizada;
- [ ] impacto de segurança revisto para ferramentas com efeito colateral.
