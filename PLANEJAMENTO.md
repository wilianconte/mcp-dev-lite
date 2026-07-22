# Planejamento — MCP Server de Desenvolvimento para Copilot Studio

## 1. Objetivo

Criar um servidor MCP (Model Context Protocol) que roda **nesta VM** e expõe ao agente do
Copilot Studio as mesmas capacidades operacionais que o agente do Claude Code possui:
executar comandos shell, ler/editar/mover/listar arquivos, usar `node`, `npm`, `gh`, etc.
O agente decide livremente **quais** comandos execut