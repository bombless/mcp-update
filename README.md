# mcp-update

A small supervisor for `bombless/chatgpt-mcp`.

## Architecture

```text
GitHub Actions
    |
    | HTTPS POST + secret + commit SHA
    v
https://bombless.duckdns.org/_update
    |
    | verify SHA directly with GitHub
    v
chatgpt-mcp
    |
    | Unix domain socket
    v
mcp-update server
    |
    +-- stop MCP
    +-- git fetch/reset to verified SHA
    +-- npm ci
    +-- npm run build
    +-- start MCP

Windows:

mcp-update agent supervisor
    |
    | named pipe \\.\pipe\mcp-update-agent
    v
chatgpt-mcp agent
```

The important design point is that `mcp-update` is the process that survives an MCP restart. `chatgpt-mcp` never needs to update or restart itself.

## Linux / Red Hat gateway

Install the supervisor separately from the MCP checkout:

```bash
git clone https://github.com/bombless/mcp-update.git /opt/mcp-update
cd /opt/mcp-update
npm ci
npm run build

git clone https://github.com/bombless/chatgpt-mcp.git /opt/chatgpt-mcp
cd /opt/chatgpt-mcp
npm ci
npm run build
```

Run the supervisor with:

```bash
MCP_REPO_DIR=/opt/chatgpt-mcp \
MCP_UPDATE_SOCKET=/run/mcp-update.sock \
node /opt/mcp-update/dist/server.js
```

The supervisor owns `/run/mcp-update.sock`, starts `npm start` in `/opt/chatgpt-mcp`, and restarts that child after an update.

### systemd example

Create `/etc/systemd/system/mcp-update.service`:

```ini
[Unit]
Description=MCP update supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/mcp-update
Environment=MCP_REPO_DIR=/opt/chatgpt-mcp
Environment=MCP_UPDATE_SOCKET=/run/mcp-update.sock
ExecStart=/usr/bin/node /opt/mcp-update/dist/server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mcp-update
```

The Caddy reverse proxy should continue to point at `127.0.0.1:8787`; the supervisor starts the MCP server on that port.

## Windows agent

Clone both repositories, build `mcp-update`, and configure the supervisor:

```powershell
cd C:\mcp\mcp-update
npm ci
npm run build

$env:AGENT_REPO_DIR='C:\mcp\chatgpt-mcp'
$env:MCP_UPDATE_PIPE='mcp-update-agent'
node dist\agent-updater.js
```

The supervisor owns `\\.\pipe\mcp-update-agent` and starts `npm run agent` in the MCP checkout. It periodically checks the public `main` SHA (10 minutes by default). A local agent can also send `{"type":"update"}` over the named pipe to request an immediate check/update.

## Update protocol

GitHub Actions sends:

```json
{
  "repository": "bombless/chatgpt-mcp",
  "ref": "refs/heads/main",
  "sha": "<40-character commit SHA>"
}
```

The public MCP endpoint requires `Authorization: Bearer <UPDATE_WEBHOOK_TOKEN>`. It then asks GitHub for the current `main` SHA and only forwards the request to the local Unix socket when the two SHAs match.

The supervisor performs a hard checkout:

```text
git fetch --prune origin main
git reset --hard <verified SHA>
git clean -fd
npm ci
npm run build
```

This intentionally discards local changes in the deployment checkout. The deployment directory should therefore contain no persistent local configuration or secrets. Keep secrets in environment variables/systemd configuration instead.

## Security

- Never expose the Unix socket or Windows named pipe over the network.
- Use a dedicated random `UPDATE_WEBHOOK_TOKEN`, different from `AGENT_TOKEN`.
- Keep the update endpoint behind HTTPS/Caddy.
- The endpoint accepts only the fixed `bombless/chatgpt-mcp` repository and `main` branch.
- The endpoint independently verifies the GitHub SHA instead of trusting the webhook body.
- The updater, not the MCP process, owns process restart privileges.
