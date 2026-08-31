import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:https';
import path from 'node:path';

export const REPO = 'bombless/chatgpt-mcp';
export const BRANCH = process.env.UPDATE_BRANCH ?? 'main';

export function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function run(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`)));
  });
}

export async function updateCheckout(repoDir: string, expectedSha: string) {
  if (!existsSync(path.join(repoDir, '.git'))) throw new Error(`Not a git checkout: ${repoDir}`);
  await run('git', ['fetch', '--prune', 'origin', BRANCH], repoDir);
  await run('git', ['reset', '--hard', expectedSha], repoDir);
  await run('git', ['clean', '-fd'], repoDir);
  await run(npmCommand(), ['ci'], repoDir);
  await run(npmCommand(), ['run', 'build'], repoDir);
}

export function startProcess(command: string, args: string[], cwd: string) {
  return spawn(command, args, { cwd, stdio: 'inherit', shell: false, detached: process.platform !== 'win32' });
}

export async function stopProcess(child: ChildProcess | undefined) {
  if (!child?.pid || child.killed) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  } else {
    child.kill();
  }
  await new Promise(resolve => setTimeout(resolve, 2_000));
  if (!child.killed) {
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    } else {
      child.kill();
    }
  }
}

export function latestGithubSha(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`,
      headers: { 'User-Agent': 'bombless-mcp-update', Accept: 'application/vnd.github+json' },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub returned ${res.statusCode}`));
        try {
          const sha = (JSON.parse(data) as { sha?: string }).sha;
          if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error('invalid GitHub SHA');
          resolve(sha.toLowerCase());
        } catch (e) { reject(e); }
      });
    });
    req.once('error', reject);
    req.end();
  });
}
