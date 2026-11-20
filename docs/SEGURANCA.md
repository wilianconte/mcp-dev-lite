# Segurança

## Premissa central

O `mcp-dev-agent` é, por desenho, um agente remoto com capacidade de executar shell e manipular arquivos na VM. Portanto, uma credencial válida deve ser tratada como acesso equivalente às permissões do usuário Linux que executa o serviço.

A aplicação não deve ser instalada em uma máquina que concentre segredos ou dados de outros ambientes sem isolamento adequado.

## Fronteiras de confiança

```text
Internet / cliente MCP não confiável
        |
        v
TLS / Cloudflare / reverse proxy
        |
        v
Autenticação MCP/OAuth
        |
        v
mcp-dev-agent
        |
        +--> shell arbitrário
        +--> filesystem irrestrito
        `--> ferramentas instaladas na VM
```

A autenticação é a principal barreira entre a internet e capacidades de desenvolvimento de alto privilégio.

## Controles existentes

### Autenticação

O `/mcp` aceita:

- `MCP_AUTH_TOKEN` estático;
- access token OAuth válido emitido pelo próprio servidor.

Sem `MCP_AUTH_TOKEN`, o processo não inicia.

### OAuth

O provider implementa:

- DCR;
- authorization code;
- PKCE por meio do handler do SDK MCP;
- authorization codes de uso único;
- expiração de tokens;
- rotação de refresh token;
- revogação;
- senha explícita para aprovar acesso.

### Proteção do estado local

`data/oauth-state.json` é ignorado pelo Git. O writer usa arquivo temporário, `chmod 0600` e rename para persistência atômica. Tokens de acesso e refresh ficam indexados por hash SHA-256. Estados antigos são migrados com backup `.bak.<timestamp>`. JSON inválido ou esquema incompatível interrompe a inicialização para evitar operar com estado silenciosamente perdido.

### Saídas grandes

O armazenamento temporário usa:

- diretório `0700`;
- arquivos `0600`;
- UUID como identificador;
- TTL de 1 hora;
- limite de 50 artefatos.

### Execução de processos

`run_command`:

- limita timeout pelo schema;
- limita a captura de saída;
- usa grupo de processos próprio em Unix;
- tenta encerrar descendentes em timeout/estouro de buffer.

## Riscos conhecidos

| Prioridade | Risco | Situação atual | Tratamento recomendado |
|---|---|---|---|
| Alta | Credencial comprometida dá acesso amplo à VM | Inerente ao desenho | VM dedicada, usuário de baixo privilégio, rotação e TLS. |
| Alta | Falta de rastreabilidade de `tools/call` | Mitigado | Auditoria estruturada com sessão/client, duração, resultado resumido e redaction. Centralizar/reter logs conforme criticidade. |
| Média | Shell e filesystem não têm sandbox/allowlist | Decisão intencional | Isolar a VM e limitar o usuário do SO em vez de confiar no processo. |
| Média | Estado OAuth local contém hashes de tokens e dados de clients | Protegido por diretório `0700`, arquivos `0600` e escrita atômica | Tratar `data/oauth-state.json` como segredo operacional e manter backups de migração sob a mesma proteção. |
| Média | Rate limit da aprovação depende de `req.ip` | Mitigado para túnel local | `trust proxy=loopback` por padrão e teste de integração; revisar `MCP_TRUST_PROXY` em topologias diferentes. |
| Média | Não há rate limit global no `/mcp`/OAuth | Não implementado | Aplicar limite no proxy/Cloudflare e, se necessário, também na aplicação. |
| Média | Body JSON do `/mcp` pode consumir memória | Mitigado | Limite padrão de `16mb` após autenticação, configurável por `MCP_REQUEST_BODY_LIMIT`; manter o menor valor compatível com os clientes. |
| Média | Sessões MCP e rate limit estão em memória | Processo único | Não escalar horizontalmente sem backend compartilhado/afinidade. |
| Baixa | `/health` é público | Intencional | Resposta mínima com status e versão, sem catálogo de ferramentas. |

## Observação sobre proxy e `req.ip`

O contador de falhas da tela de aprovação usa `req.ip`. O servidor configura `trust proxy=loopback` por padrão: requests vindos do proxy local podem usar o IP encaminhado, enquanto clientes remotos diretos não ganham confiança automática em `X-Forwarded-For`.

Esse comportamento é coberto por teste de integração. Se o proxy deixar de rodar em loopback ou houver múltiplos hops, ajuste `MCP_TRUST_PROXY` explicitamente e valide novamente o IP efetivo.

## Segredos

Trate como segredo:

- `MCP_AUTH_TOKEN`;
- `OAUTH_APPROVAL_PASSWORD`;
- `data/oauth-state.json`;
- credenciais do Cloudflare Tunnel;
- tokens de CLIs disponíveis ao usuário do serviço, como `gh`;
- chaves SSH e arquivos de configuração acessíveis pelo usuário do processo.

Nunca grave esses valores em README, issue, prompt compartilhado ou log de auditoria.

## Hardening recomendado

### Sistema operacional

- execute com usuário dedicado e sem `sudo` não interativo;
- não rode como `root`;
- use VM/container dedicado ao escopo de desenvolvimento;
- reduza permissões sobre diretórios e credenciais que o agente não precisa acessar;
- mantenha sistema e runtime atualizados.

### Rede

- mantenha `HOST=127.0.0.1` atrás de proxy/túnel;
- exponha apenas HTTPS;
- não publique a porta HTTP diretamente;
- use controles de rate limiting/WAF do proxy quando disponíveis;
- limite origens e identidades quando a arquitetura permitir.

### Credenciais

- use tokens aleatórios fortes;
- mantenha senha OAuth diferente do token estático;
- rotacione credenciais periodicamente e após suspeita de exposição;
- restrinja permissão de `.env` e do estado OAuth.
- o login web do monitor valida `MCP_AUTH_TOKEN` no servidor e mantém apenas um cookie de sessão temporário no navegador;

### Observabilidade

Cada execução de ferramenta (`tools/call` validado) gera um evento estruturado `mcp.tool_call` com timestamp, sessão, request, client ID quando disponível, IP, duração, argumentos sanitizados e resumo de resultado/erro. Por padrão o evento vai para stderr/journald e `data/audit.jsonl`; `MCP_AUDIT_LOG_PATH` permite escolher outro arquivo ou desativar a cópia em arquivo com `false`.

A sanitização mascara chaves como `token`, `password`, `secret`, `authorization` e padrões comuns embutidos em strings. Conteúdo integral de arquivos, stdout e imagens não é duplicado na auditoria.

## Resposta a incidente de credencial

Se houver suspeita de comprometimento:

1. interrompa ou isole o endpoint público;
2. rotacione `MCP_AUTH_TOKEN` e `OAUTH_APPROVAL_PASSWORD`;
3. revogue tokens OAuth; apagar o estado OAuth e reiniciar força nova autorização de todos os clients;
4. revise logs do sistema, shell, Git e serviços disponíveis;
5. considere a VM potencialmente acessada com todas as permissões do usuário do serviço;
6. reprovisione uma VM descartável quando o nível de confiança não puder ser restabelecido.

## Critério para produção

Antes de classificar o serviço como pronto para um ambiente com dados relevantes, no mínimo:

- [ ] VM/usuário dedicados e de baixo privilégio;
- [ ] endpoint disponível somente por HTTPS;
- [ ] credenciais fortes e separadas;
- [ ] rate limiting no perímetro;
- [x] comportamento de IP atrás do proxy validado para proxy local/loopback;
- [ ] política de rotação/revogação definida;
- [ ] logs operacionais centralizados;
- [x] auditoria de `tools/call` estruturada e com redaction;
- [x] testes de autenticação/OAuth incluídos na suíte;
- [ ] processo de recuperação/reprovisionamento documentado.
