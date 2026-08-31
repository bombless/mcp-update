import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startProcess, stopProcess, updateCheckout, latestGithubSha, REPO, BRANCH, npmCommand } from './common.js';

const execFileAsync = promisify(execFile);
if (process.platform !== 'win32') throw new Error('agent updater must run on Windows');

const repoDir = process.env.AGENT_REPO_DIR ?? 'C:\\mcp\\chatgpt-mcp';
const pipeName = process.env.MCP_UPDATE_PIPE ?? 'mcp-update-agent';
const pipePath = `\\\\.\\pipe\\${pipeName}`;
const checkIntervalMs = Number(process.env.AGENT_UPDATE_CHECK_INTERVAL_MS ?? 10 * 60 * 1000);
let agentProcess: ReturnType<typeof startProcess> | undefined;
let updating = false;

function startAgent() {
  if (agentProcess && !agentProcess.killed) return;
  agentProcess = startProcess(npmCommand(), ['run', 'agent'], repoDir);
  agentProcess.once('exit', (code, signal) => {
    console.log(`[agent] exited code=${code} signal=${signal}`);
    agentProcess = undefined;
    if (!updating) setTimeout(startAgent, 1_000);
  });
}

async function doUpdate() {
  if (updating) return;
  updating = true;
  try {
    const sha = await latestGithubSha();
    console.log(`[update] latest ${REPO}@${BRANCH}: ${sha}`);
    await stopProcess(agentProcess);
    agentProcess = undefined;
    await updateCheckout(repoDir, sha);
    console.log('[update] build succeeded; starting agent');
    startAgent();
  } catch (error) {
    console.error('[update] failed:', error);
    startAgent();
  } finally {
    updating = false;
  }
}

function startPipeServer() {
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
          const message = JSON.parse(line) as { type?: string };
          if (message.type !== 'update') throw new Error('invalid request');
          socket.write(JSON.stringify({ ok: true, accepted: true }) + '\n');
          void doUpdate();
        } catch (error) {
          socket.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n');
        }
      }
    });
  });
  server.listen(pipePath, () => console.log(`[mcp-update] named pipe: ${pipePath}`));
}

async function autoCheck() {
  try {
    const latest = await latestGithubSha();
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    const current = stdout.trim().toLowerCase();
    if (latest !== current) {
      console.log(`[update] agent is behind: ${current} -> ${latest}`);
      await doUpdate();
    }
  } catch (error) {
    console.error('[update] check failed:', error);
  }
}

startPipeServer();
startAgent();
setInterval(() => void autoCheck(), checkIntervalMs);
