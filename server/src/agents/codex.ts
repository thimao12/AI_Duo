import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveBin } from './bins.ts';
import { spawnJsonl } from './process.ts';
import type { AgentAdapter, AgentEvent, Role, RunOptions, RunResult } from './types.ts';

function sandboxFor(role: Role): 'read-only' | 'workspace-write' {
  return role === 'thinker' ? 'read-only' : 'workspace-write';
}

export interface CodexJsonState {
  sessionId?: string;
  messages: string[];
  completed: boolean;
  failed: boolean;
  lastError?: string;
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
    const sandbox = sandboxFor(o.role);

    // `exec resume` accepts neither -C nor -s, so sandbox goes through -c and cwd through spawn.
    const args = o.sessionId
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`, '-o', lastFile]
      : ['exec', '--json', '--skip-git-repo-check', '-C', o.cwd, '-s', sandbox, '-o', lastFile];
    if (o.model) args.push('-m', o.model);
    if (o.sessionId) args.push(o.sessionId);
    args.push('-'); // prompt from stdin

    let state = initialCodexJsonState(o.sessionId);

    try {
      const { code, stderr } = await spawnJsonl(resolveBin('codex'), args, {
        cwd: o.cwd,
        stdin: o.prompt,
        signal: o.signal,
        timeoutMs: o.timeoutMs ?? 10 * 60_000,
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
      return { finalText, sessionId: state.sessionId };
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
