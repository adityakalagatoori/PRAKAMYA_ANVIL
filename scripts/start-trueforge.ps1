# Starts TrueForge in local mode on http://localhost:8790.
# Anvil's MCP server runs inside VS Code on 127.0.0.1, so TrueForge's outbound URL guard must allow
# loopback hosts. We allow-list them explicitly instead of disabling the policy.
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","localhost"]'
if ($args -contains '--no-network-policy') { $env:NETWORK_POLICY_ENABLED = 'false' }
npx -y @truefoundry/trueforge@latest
