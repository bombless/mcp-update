import net from 'node:net';
import fs from 'node:fs/promises';
import { startProcess, stopProcess, updateCheckout, REPO, BRANCH, npmCommand } from './common.js';

if (process.platform === 'win32') throw new Error('server supervisor must run on Linux/Unix');

const repoDir = process.env.MCP_REPO_DIR ?? '/opt/chatgpt-mcp';
const socketPath = process.env.MCP_UPDATE_SOCKET ?? '/run/mcp-update.sock';
let mcpProcess: ReturnType<typeof startProcess> | undefined;
let updating = false;
let queuedSha: string | undefined;

function startMcp() {
  if (mcpProcess && !mcpProcess.killed) return;
  mcpProcess = startProcess(npmCommand(), ['start'], repoDir);
  mcpProcess.once('exit', (code, signal) => {
    console.log(`[mcp] exited code=${code} signal=${signal}`);
    mcpProcess = undefined;
    if (!updating) setTimeout(startMcp, 1_000);
  });
}

async function doUpdate(expectedSha: string) {
  if (updating) { queuedSha = expectedSha; return; }
  updating = true;
  try {
    console.log(`[update] updating ${REPO}@${BRANCH} -> ${expectedSha}`);
    await stopProcess(mcpProcess);
    mcpProcess = undefined;
    await updateCheckout(repoDir, expectedSha);
    console.log('[update] build succeeded; starting MCP');
    startMcp();
  } catch (error) {
    console.error('[update] failed:', error);
    startMcp();
  } finally {
    updating = false;
    const next = queuedSha;
    queuedSha = undefined;
    if (next) void doUpdate(next);
  }
}

async function main() {
  await fs.rm(socketPath, { force: true });
  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', data => {
      buffer += data;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as { type?: string; repository?: string; branch?: string; sha?: string };
          if (message.type !== 'update' || message.repository !== REPO || message.branch !== BRANCH || !message.sha || !/^[0-9a-f]{40}$/i.test(message.sha)) {
            socket.write(JSON.stringify({ ok: false, error: 'invalid update request' }) + '\n');
            continue;
          }
          socket.write(JSON.stringify({ ok: true, accepted: true }) + '\n');
          void doUpdate(message.sha.toLowerCase());
        } catch (error) {
          socket.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n');
        }
      }
    });
  });
  server.listen(socketPath, async () => {
    await fs.chmod(socketPath, 0o600);
    console.log(`[mcp-update] Unix socket: ${socketPath}`);
    console.log(`[mcp-update] supervising ${repoDir}`);
    startMcp();
  });
  process.on('SIGTERM', async () => { await stopProcess(mcpProcess); server.close(); await fs.rm(socketPath, { force: true }); process.exit(0); });
  process.on('SIGINT', async () => { await stopProcess(mcpProcess); server.close(); await fs.rm(socketPath, { force: true }); process.exit(0); });
}

void main();
