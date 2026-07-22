#!/usr/bin/env bash
#
# Provisiona um Cloudflare Tunnel nomeado para o servidor MCP.
#
# PRE-REQUISITO (feito UMA vez, por voce, pois exige a sua conta Cloudflare):
#   cloudflared tunnel login
# Isso abre o browser, voce escolhe a zona/dominio e grava ~/.cloudflared/cert.pem.
#
# Uso:
#   ./scripts/provision-cloudflare.sh mcp.seudominio.com [nome-do-tunnel]
#
# O hostname precisa estar sob um dominio que ja exista na sua conta Cloudflare.
set -euo pipefail

HOSTNAME="${1:-}"
TUNNEL_NAME="${2:-mcp-dev-agent}"
CF_DIR="${HOME}/.cloudflared"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$HOSTNAME" ]]; then
  echo "ERRO: informe o hostname publico. Ex: $0 mcp.seudominio.com" >&2
  exit 1
fi

if [[ ! -f "${CF_DIR}/cert.pem" ]]; then
  echo "ERRO: nao autenticado. Rode primeiro:  cloudflared tunnel login" >&2
  echo "(abre o browser e grava ${CF_DIR}/cert.pem)" >&2
  exit 1
fi

echo ">> Criando tunnel '${TUNNEL_NAME}' (ignora se ja existir)..."
exists="$(cloudflared tunnel list -o json | python3 -c \
  "import sys,json;print(any(t['name']=='${TUNNEL_NAME}' for t in json.load(sys.stdin)))")"
if [[ "$exists" != "True" ]]; then
  cloudflared tunnel create "${TUNNEL_NAME}"
fi

TUNNEL_ID="$(cloudflared tunnel list -o json | python3 -c \
  "import sys,json;print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='${TUNNEL_NAME}'))")"
CRED_FILE="${CF_DIR}/${TUNNEL_ID}.json"
echo ">> Tunnel ID: ${TUNNEL_ID}"

echo ">> Gerando ${CF_DIR}/config.yml..."
sed -e "s|__TUNNEL_ID__|${TUNNEL_ID}|" \
    -e "s|__CREDENTIALS_FILE__|${CRED_FILE}|" \
    -e "s|__HOSTNAME__|${HOSTNAME}|" \
    "${REPO_DIR}/deploy/cloudflared-config.template.yml" > "${CF_DIR}/config.yml"

echo ">> Roteando DNS ${HOSTNAME} -> tunnel..."
cloudflared tunnel route dns "${TUNNEL_NAME}" "${HOSTNAME}"

cat <<EOF

Pronto. Tunnel '${TUNNEL_NAME}' provisionado para https://${HOSTNAME}

Testar agora (mantem em foreground):
  cloudflared tunnel run ${TUNNEL_NAME}

Instalar como servico de sistema (inicia no boot):
  sudo cloudflared --config ${CF_DIR}/config.yml service install
  sudo systemctl enable --now cloudflared

URL para o connector do Copilot Studio:
  https://${HOSTNAME}/mcp   (header Authorization: Bearer \$MCP_AUTH_TOKEN)
EOF
