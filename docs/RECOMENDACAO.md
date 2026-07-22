# Recomendação de arquitetura e próximos passos

Documento de recomendação para o `mcp-dev-agent`. Resume as decisões tomadas, o que recomendo adicionar antes de produção e a estratégia de exposição escolhida (Cloudflare Tunnel).

## 1. Decisões já aplicadas

| Tema | Decisão | Motivo |
|---|---|---|
| Transporte | Streamable HTTP (`/mcp`) | É o modo que o Copilot Studio consome MCP. |
| Autenticação | Bearer token (`MCP_AUTH_TOKEN`) | Barreira mínima obrigatória; sem token, o endpoint é acesso root remoto. |
| Escopo de arquivos | Sem restrição de path | Escolha do usuário — máxima autonomia do agente na VM. |

## 2. Exposição: Cloudflare Tunnel (recomendado)

Recomendo **Cloudflare Tunnel** (`cloudflared`) em vez de abrir portas ou usar `ngrok`:

- **Não abre nenhuma porta de entrada na VM.** O `cloudflared` faz uma conexão *de saída* para a borda da Cloudflare; o servidor MCP continua ouvindo só em `127.0.0.1`.
- **TLS gerenciado** pela Cloudflare — o Copilot Studio exige HTTPS público, e isso é resolvido sem certificado manual.
- **Hostname estável** (`mcp.seudominio.com`) em vez de URL efêmera, essencial porque o connector do Copilot Studio guarda a URL.
- **Camadas extras opcionais**: WAF, rate limiting e Cloudflare Access (mTLS / SSO) na frente do túnel.

Alternativa só para teste rápido: *quick tunnel* (`cloudflared tunnel --url ...`) gera uma URL `*.trycloudflare.com` efêmera, sem conta nem domínio. Não usar em produção.

Passo a passo completo em [`DEPLOY-CLOUDFLARE.md`](./DEPLOY-CLOUDFLARE.md).

## 3. Recomendo adicionar antes de produção

### 3.1 Log de auditoria (prioridade alta)
Como o servidor executa comandos arbitrários, registre cada `tools/call` recebido: timestamp, nome da ferramenta, argumentos e código de saída. Sem isso não há rastreabilidade de "o que o agente fez na VM". Direcionar para arquivo com rotação ou para `journald`/SIEM.

### 3.2 Spec OpenAPI para custom connector (prioridade média)
Se a licença/região do Copilot Studio não oferecer MCP nativo, é necessário um **custom connector** com spec OpenAPI descrevendo o endpoint `/mcp` (Streamable HTTP) e o header `Authorization`. Manter a spec versionada no repo evita retrabalho na hora de publicar.

### 3.3 Endurecimento operacional
- Rodar o processo como **usuário de baixo privilégio** dedicado, nunca `root`.
- Usar uma **VM isolada/descartável** por projeto; não apontar para máquinas com dados sensíveis de terceiros.
- **Rotacionar** o `MCP_AUTH_TOKEN` periodicamente; tratá-lo como credencial root.
- Opcional: **Cloudflare Access** na frente do túnel para exigir identidade além do Bearer token.

## 4. O que fica fora de escopo (e por quê)
- **Restrição de path / sandbox de comandos**: descartado por decisão explícita do usuário (autonomia total).
- **Cloudflare Workers**: não serve aqui — não roda processo Node persistente executando shell na VM. O túnel é o mecanismo correto.
