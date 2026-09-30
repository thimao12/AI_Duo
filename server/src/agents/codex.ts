import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentEnv, assertPlanOnly } from './billing.ts';
import { resolveBin } from './bins.ts';
import { getCliSettingsSync } from '../settings.ts';
import { checkAgent } from './check.ts';
import { spawnJsonl } from './process.ts';
import type { AgentAdapter, AgentEvent, Role, RunOptions, RunResult, Usage } from './types.ts';

/** An explicit permission replaces the role's tier: edit writes, read only writes for a reviewer (it runs tests). */
export function sandboxFor(role: Role, permission?: 'read' | 'edit'): 'read-only' | 'workspace-write' {
  if (permission === 'edit') return 'workspace-write';
  if (permission === 'read') return role === 'reviewer' ? 'workspace-write' : 'read-only';
  return role === 'thinker' ? 'read-only' : 'workspace-write';
}

export interface CodexJsonState {
  sessionId?: string;
  messages: string[];
  completed: boolean;
  failed: boolean;
  lastError?: string;
  usage?: Usage;
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** `turn.completed` usage; Codex's input_tokens already includes the cached part. */
export function codexUsage(u: any): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cachedInputTokens: num(u.cached_input_tokens) };
}

export function initialCodexJsonState(sessionId?: string): CodexJsonState {
  return { sessionId, messages: [], completed: false, failed: false };
}

export function onJson(ev: any, state: CodexJsonState): { state: CodexJsonState; events: AgentEvent[] } {
  const next = { ...state, messages: [...state.messages] };
  const events: AgentEvent[] = [];
  const item = ev.item;
  switch (ev.type) {
    case 'thread.started':
      next.sessionId = ev.thread_id;
      break;
    case 'item.started':
      if (item?.type === 'command_execution') events.push({ kind: 'tool', content: `Shell: ${item.command}` });
      else if (item?.type === 'mcp_tool_call') events.push({ kind: 'tool', content: `MCP: ${item.server}/${item.tool}` });
      else if (item?.type === 'web_search') events.push({ kind: 'tool', content: `WebSearch: ${item.query ?? ''}` });
      break;
    case 'item.completed':
      if (item?.type === 'agent_message' && item.text) {
        next.messages.push(item.text);
        events.push({ kind: 'text', content: item.text });
      } else if (item?.type === 'command_execution') {
        const out = String(item.aggregated_output ?? '');
        events.push({
          kind: 'tool_result',
          content: `exit ${item.exit_code ?? '?'}\n${out.length > 4000 ? out.slice(0, 4000) + '\n…' : out}`,
        });
      } else if (item?.type === 'file_change') {
        const changes = (item.changes ?? []).map((c: any) => `${c.kind ?? 'edit'} ${c.path}`).join('\n');
        events.push({ kind: 'tool', content: `Edit files:\n${changes}` });
      } else if (item?.type === 'error') {
        events.push({ kind: 'error', content: item.message ?? 'error' });
      }
      break;
    case 'turn.completed':
      next.completed = true;
      next.usage = codexUsage(ev.usage);
      break;
    case 'turn.failed':
      next.failed = true;
      next.lastError = ev.error?.message ?? 'Codex turn failed';
      break;
    case 'error':
      next.lastError = ev.message ?? 'Codex error';
      events.push({ kind: 'error', content: next.lastError! });
      break;
  }
  return { state: next, events };
}

export function codexError(state: CodexJsonState, code: number, stderr: string): string | undefined {
  if (state.failed) return state.lastError ?? 'Codex turn failed';
  if (!state.completed && (state.lastError || code !== 0)) {
    return state.lastError ?? `codex exited with code ${code}: ${stderr.trim().slice(-1500)}`;
  }
}

export const codex: AgentAdapter = {
  name: 'codex',
  async run(o: RunOptions): Promise<RunResult> {
    const dir = await mkdtemp(path.join(tmpdir(), 'ai-duo-codex-'));
    const lastFile = path.join(dir, 'last.txt');
    const sandbox = sandboxFor(o.role, o.permission);

    // `exec resume` accepts neither -C nor -s, so sandbox goes through -c and cwd through spawn.
    const args = o.sessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`, '-o', lastFile]
      : ['exec', '--json', '--skip-git-repo-check', '-C', o.cwd, '-s', sandbox, '-o', lastFile];
    if (o.model) args.push('-m', o.model);
    if (o.effort) args.push('-c', `model_reasoning_effort="${o.effort}"`);
    for (const image of o.images ?? []) args.push('--image', image);
    // Saved extra arguments stay before the positionals; the prompt is always the trailing '-' on stdin.
    args.push(...(getCliSettingsSync().codex.extraArgs ?? []));
    if (o.sessionId) args.push(o.sessionId);
    args.push('-'); // prompt from stdin

    let state = initialCodexJsonState(o.sessionId);

    try {
      const bin = resolveBin('codex');
      await assertPlanOnly('codex', bin, o.cwd, { allowUnverifiedAuth: o.allowUnverifiedAuth });
      const { code, stderr } = await spawnJsonl(bin.cmd, [...bin.prefixArgs, ...args], {
        cwd: o.cwd,
        stdin: o.prompt,
        signal: o.signal,
        timeoutMs: o.timeoutMs ?? 10 * 60_000,
        env: agentEnv(bin),
        onRawLine: (line) => o.onEvent({ kind: 'raw', content: line }),
        onJson: (ev) => {
          const result = onJson(ev, state);
          state = result.state;
          for (const event of result.events) o.onEvent(event);
        },
      });

      const error = codexError(state, code, stderr);
      if (error) throw new Error(error);
      let finalText = await readFile(lastFile, 'utf8').catch(() => '');
      if (!finalText) finalText = state.messages.join('\n\n');
      return { finalText, sessionId: state.sessionId, usage: state.usage };
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
  check: (cwd) => checkAgent('codex', cwd),
};
