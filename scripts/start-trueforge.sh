#!/usr/bin/env bash
# Starts TrueForge in local mode on http://localhost:8790.
# Anvil's MCP server runs inside VS Code on 127.0.0.1, so TrueForge's outbound URL guard must allow
# loopback hosts. We allow-list them explicitly instead of disabling the policy.
set -euo pipefail
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'
# Local models can take a while to load into VRAM before the first token; allow it.
export MODEL_HTTP_HEADERS_TIMEOUT_MS=300000
if [[ "${1:-}" == "--no-network-policy" ]]; then export NETWORK_POLICY_ENABLED=false; fi
exec npx -y @truefoundry/trueforge@latest
