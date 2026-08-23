# Avaliação técnica

**Data da avaliação:** 23 de agosto de 2026

**Versão avaliada:** `1.2.0`
**Escopo:** código-fonte, testes, autenticação, operação, deploy e documentação do `mcp-dev-agent` no estado atual do diretório de trabalho.

## Resumo executivo

A aplicação está pequena, coesa e tecnicamente consistente para o objetivo de fornecer capacidades de desenvolvimento por MCP. O código compila em TypeScript estrito, a suíte automatizada passa e o servidor possui cobertura de integração para os principais fluxos de autenticação e sessão.

A versão `1.2.0` adiciona os controles que eram a principal lacuna da avaliação anterior: auditoria estruturada de `tools/call`, validação do comportamento de IP atrás de proxy local e teste end-to-end de MCP/OAuth.

O maior risco continua sendo inerente ao produto: uma credencial válida permite executar shell e acessar qualquer caminho permitido ao usuário Linux do serviço. Por isso, isolamento da VM, credenciais e proteção de perímetro continuam sendo controles essenciais.

## Validações executadas

```text
npm run typecheck  -> aprovado
npm test           -> 7/7 testes aprovados
npm audit --omit=dev --audit-level=moderate -> 0 vulnerabilidades conhecidas na última verificação
```

A suíte cobre atualmente:

1. redaction de segredos na auditoria;
2. servidor real com Bearer token, handshake MCP, sessão, `tools/list` e `tools/call`;
3. auditoria em JSONL e identificação de IP via proxy confiável;
4. OAuth DCR + authorization code + PKCE;
5. refresh token com rotação e rejeição do token antigo;
6. revogação de access token;
7. paginação de saída grande;
8. encerramento de grupo de processos em timeout;
9. paginação de arquivo por caracteres;
10. leitura de imagem MCP nativa;
11. paginação de diretório.

Os itens acima estão distribuídos em 7 casos de teste automatizados.

## Capacidades atuais

A versão `1.2.0` expõe 10 ferramentas:

1. `run_command`
2. `read_command_output`
3. `read_file`
4. `read_image`
5. `write_file`
6. `edit_file`
7. `list_directory`
8. `move_file`
9. `make_directory`
10. `delete_path`

## Melhorias implementadas nesta evolução

### Auditoria estruturada

Cada execução efetiva de ferramenta gera um evento `mcp.tool_call` com:

- timestamp;
- ferramenta;
- session ID;
- request ID;
- client ID quando identificável;
- IP calculado na criação da sessão;
- duração;
- argumentos sanitizados;
- resumo do resultado ou erro.

A auditoria não grava o conteúdo integral retornado pelas tools. Ela registra apenas tipos de conteúdo e contagens aproximadas, reduzindo risco de replicar arquivos, stdout ou imagens nos logs.

Campos sensíveis por nome são substituídos por `[REDACTED]`. Strings também passam por redaction de padrões comuns como `Bearer`, `token=`, `password=` e `api_key=`. Valores muito grandes são truncados.

Por padrão a linha JSON é enviada para `stderr`, o que integra naturalmente com `journald`. Opcionalmente, `MCP_AUDIT_LOG_PATH` grava o mesmo evento em arquivo JSONL.

### Proxy e `req.ip`

O Express agora usa `trust proxy=loopback` por padrão. Isso é adequado ao deployment recomendado, no qual `cloudflared` se conecta localmente à aplicação.

A configuração permite que `req.ip` considere o IP encaminhado pelo proxy quando a conexão chega de loopback, sem confiar indiscriminadamente em `X-Forwarded-For` enviado por um cliente remoto direto.

O teste de integração valida esse comportamento usando um proxy local simulado.

### Cobertura de integração

O teste `test/server.test.mjs` sobe uma instância real de `dist/server.js` em porta temporária e usa diretórios isolados para estado OAuth e auditoria.

Isso detecta regressões que testes unitários das ferramentas não encontrariam, especialmente mudanças no SDK MCP, headers de sessão e fluxo OAuth.

## Pontos fortes

### Estrutura simples

As responsabilidades continuam bem separadas:

- `server.ts`: HTTP, MCP, autenticação e sessão;
- `oauth.ts`: provider OAuth;
- `tools.ts`: catálogo de ferramentas;
- `output-store.ts`: outputs textuais grandes;
- `audit.ts`: auditoria e sanitização.

Não há motivo técnico atual para adicionar framework, banco ou fila apenas para aumentar a abstração.

### Resultado MCP multimodal

`read_image` retorna `ImageContent` MCP nativo e evita transportar screenshots como base64 textual dentro de comandos shell.

### Saídas grandes recuperáveis

Resultados extensos de `run_command` recebem `artifact_id`, preview de início/fim e paginação posterior com `read_command_output`.

### OAuth compatível com clientes MCP

O fluxo cobre DCR, authorization code, PKCE, refresh token, rotação e revogação. O teste end-to-end exercita o fluxo real do SDK.

## Riscos e próximos passos

### P0 — operação segura

#### Isolamento da VM

Permanece obrigatório. O servidor não tem sandbox de shell nem restrição de path por decisão de arquitetura.

Recomendado:

- usuário Linux dedicado;
- sem `sudo` não interativo;
- VM/container dedicado ao desenvolvimento;
- `HOST=127.0.0.1` atrás do Cloudflare Tunnel;
- ausência de segredos de outros ambientes acessíveis ao usuário do serviço.

#### Rate limiting de perímetro

Os endpoints OAuth do SDK possuem limites próprios e a aprovação possui limite adicional por IP, mas `/mcp` continua sem limite global de aplicação.

A recomendação principal é rate limiting/WAF no Cloudflare ou reverse proxy, pois essa camada pode bloquear abuso antes de consumir recursos da VM.

### P1 — evolução funcional

#### Captura visual nativa

A próxima evolução com maior valor para o objetivo do projeto é adicionar uma ferramenta de screenshot, preferencialmente baseada em Playwright, que retorne diretamente `ImageContent` MCP.

Isso elimina o fluxo em duas etapas `run_command -> read_image` para inspeção visual.

#### Busca estruturada

Uma ferramenta `search_files` pode reduzir output de shell e devolver resultados paginados/estruturados para buscas recorrentes em repositórios grandes.

#### Workspace ativo

Um conceito opcional de workspace facilitaria navegação entre vários projetos sem remover a possibilidade de caminhos absolutos.

### P2 — manutenção

#### Fonte única da versão

A versão ainda aparece em `package.json` e no `serverInfo` de `src/server.ts`. Vale consolidar em uma fonte única quando isso puder ser feito sem complicar o build ESM.

#### Auditoria em arquivo

Quando `MCP_AUDIT_LOG_PATH` é usado, a rotação deve ser responsabilidade do sistema operacional/logrotate ou de outro coletor. `journald` continua sendo a opção preferida para produção simples.

#### Estado local

OAuth e sessões continuam desenhados para instância única. Escala horizontal exigiria afinidade ou backend compartilhado e não é recomendada sem uma necessidade real.

## Matriz de maturidade

| Área | Estado | Comentário |
|---|---|---|
| Estrutura de código | Bom | Módulos pequenos e responsabilidades claras. |
| Tipagem/build | Bom | TypeScript estrito e build verde. |
| Ferramentas MCP | Bom | 10 ferramentas, paginação e multimodalidade. |
| Testes de tools | Bom | Cobertura dos riscos recentes. |
| Testes de integração | Bom para o porte atual | MCP, Bearer, OAuth, proxy e auditoria cobertos. |
| Autenticação | Bom | Bearer estático + OAuth com PKCE/refresh/revogação. |
| Auditoria | Bom | JSON estruturado com redaction; arquivo opcional. |
| Segurança de execução | Dependente do ambiente | Shell/filesystem amplos por desenho. |
| Deploy | Documentado | Cloudflare Tunnel + systemd. |
| Escalabilidade horizontal | Não projetada | Estado local; manter instância única. |
| Multimodalidade | Boa base | `read_image` nativo; captura automática é próxima evolução. |

## Conclusão

A versão `1.2.0` resolve as principais lacunas de rastreabilidade e cobertura de integração identificadas anteriormente. Para o uso pretendido em uma VM de desenvolvimento dedicada, a base está madura o suficiente para evoluir agora principalmente em **capacidade funcional multimodal**, sem abandonar o hardening operacional no perímetro.
