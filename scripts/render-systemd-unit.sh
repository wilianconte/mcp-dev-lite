#!/usr/bin/env bash
set -euo pipefail

project_dir="${MCP_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
template="${MCP_UNIT_TEMPLATE:-$project_dir/deploy/mcp-dev-agent.service}"
service_name="${MCP_SERVICE_NAME:-mcp-dev-agent.service}"
output_path="${1:-/tmp/$service_name}"
run_user="${MCP_RUN_USER:-root}"
env_file="${MCP_ENV_FILE:-$project_dir/.env}"
node_bin="${MCP_NODE_BIN:-$(dirname "$(command -v node)")}"
port="${MCP_PORT:-3000}"
public_url="${MCP_PUBLIC_URL:-http://127.0.0.1:$port}"
data_dir="${MCP_DATA_DIR:-$project_dir/data}"

escape_sed() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

sed \
  -e "s|__RUN_USER__|$(escape_sed "$run_user")|g" \
  -e "s|__REPO_DIR__|$(escape_sed "$project_dir")|g" \
  -e "s|__NODE_BIN__|$(escape_sed "$node_bin")|g" \
  -e "s|__PORT__|$(escape_sed "$port")|g" \
  -e "s|__PUBLIC_URL__|$(escape_sed "$public_url")|g" \
  -e "s|__DATA_DIR__|$(escape_sed "$data_dir")|g" \
  "$template" > "$output_path"

sed -i "s|^EnvironmentFile=.*|EnvironmentFile=$(escape_sed "$env_file")|" "$output_path"
chmod 0644 "$output_path"
printf 'unit gerado em %s\n' "$output_path"
