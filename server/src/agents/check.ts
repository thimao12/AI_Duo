import { execFile } from 'node:child_process';
import { agentEnv, authStatus } from './billing.ts';
import { resolveBin, type ResolvedBin } from './bins.ts';
import type { AgentCheck, AgentName } from './types.ts';

const ENV: Record<AgentName, string> = { claude: 'CLAUDE_BIN', codex: 'CODEX_BIN' };
const label = (agent: AgentName) => (agent === 'claude' ? 'Claude' : 'Codex');

/** `<cli> --version`, or the reason it could not run. */
export function binVersion(bin: ResolvedBin): Promise<{ version: string | null; error?: string }> {
  return new Promise((resolve) => {
    const done = (err: (Error & { killed?: boolean }) | null, out: string) =>
      resolve(err ? { version: null, error: err.killed ? 'timed out after 15s' : err.message.split('\n')[0] } : { version: out.trim() });
    try {
      execFile(bin.cmd, [...bin.prefixArgs, '--version'], { timeout: 15000, windowsHide: true, shell: false, env: agentEnv(bin) }, done);
    } catch (err) {
      // Some files cannot even be started (e.g. spawn EFTYPE); that is a result, not a crash.
      done(err as Error, '');
    }
  });
}

export async function checkAgent(agent: AgentName, cwd: string): Promise<AgentCheck> {
  let bin: ResolvedBin;
  try {
    bin = resolveBin(agent);
  } catch (err) {
    return { agent, path: null, version: null, error: (err as Error).message, auth: 'skipped' };
  }
  const { version, error } = await binVersion(bin);
  if (!version) {
    return {
      agent,
      path: bin.resolvedFrom,
      version: null,
      error: `Không chạy được ${label(agent)} CLI (${bin.resolvedFrom} --version: ${error ?? 'no output'}). Cài CLI hoặc đặt ${ENV[agent]}.`,
      auth: 'skipped',
    };
  }
  const auth = await authStatus(agent, bin, cwd);
  return { agent, path: bin.resolvedFrom, version, auth: auth.state, ...(auth.state !== 'ok' && { authError: auth.error }) };
}
