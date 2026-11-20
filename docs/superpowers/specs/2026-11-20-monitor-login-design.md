# Login do painel de monitoramento

## Intenção

Permitir que uma pessoa abra `/logs` no navegador e faça login usando o mesmo valor configurado em `MCP_AUTH_TOKEN`, sem precisar editar headers HTTP manualmente.

## Objetivos

- Exibir uma tela de login quando o painel não tiver sessão administrativa válida.
- Validar o token exclusivamente no servidor.
- Reutilizar a sessão por cookie `HttpOnly`, `SameSite=Strict`, com expiração temporária.
- Manter o fluxo atual do painel e do `EventSource` depois do login.
- Rejeitar token ausente ou inválido sem revelar detalhes da credencial.

## Fora de escopo

- Criar credenciais administrativas separadas.
- Persistir sessões em banco ou arquivo.
- Armazenar o token no `localStorage`, `sessionStorage` ou JavaScript do navegador.
- Alterar a autenticação do endpoint `/mcp`.

## Abordagens consideradas

1. **Login server-side no painel**, escolhido. O servidor renderiza `/logs/login`, recebe `POST /logs/login`, valida `MCP_AUTH_TOKEN` e emite o cookie administrativo já usado pelo painel. Preserva o SSE e mantém o token fora do navegador.
2. Login client-side com Bearer em cada chamada. Tem menos código de rota, mas expõe o token ao JavaScript e ao armazenamento do navegador.
3. OAuth administrativo separado. Oferece identidade própria, mas adiciona estado e configuração sem necessidade para o uso atual do painel.

## Comportamento

- `GET /logs` sem sessão válida redireciona para `/logs/login` quando a requisição aceita HTML.
- `GET /logs/login` entrega o formulário sem exigir autenticação.
- `POST /logs/login` recebe o token em formulário, valida no servidor e redireciona para `/logs` em sucesso.
- Falha de login retorna a mesma tela com mensagem genérica e status `401`.
- Requisições JSON ou SSE sem sessão continuam recebendo `401` para não quebrar clientes programáticos.
- O cookie de sessão usa o mesmo TTL e limite de sessões já definidos para o painel.

## Verificação

- Testar redirecionamento para a tela sem sessão.
- Testar login inválido sem criação de sessão.
- Testar login válido e acesso subsequente ao painel, KPIs e SSE usando somente cookie.
- Testar que o token não aparece no HTML retornado.
