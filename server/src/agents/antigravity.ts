import { agentEnv, assertPlanOnly } from './billing.ts';
import { resolveBin } from './bins.ts';
import { getCliSettingsSync } from '../settings.ts';
import { checkAgent } from './check.ts';
import { spawnJsonl } from './process.ts';
import type { AgentAdapter, AgentEvent, RunOptions, RunResult, Usage } from './types.ts';

export interface AgyState {
  sessionId?: string;
  /** Streamed text of the agent's replies, in case the closing `result` carries none. */
  streamed: string;
  response?: string;
  status?: string;
  error?: string;
  usage?: Usage;
  denied: string[];
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** agy's `output_tokens` already counts thinking tokens; `cache_read_tokens` is the cached part of the input. */
export function agyUsage(u: any): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cachedInputTokens: num(u.cache_read_tokens) };
}

export function initialAgyState(sessionId?: string): AgyState {
  return { sessionId, streamed: '', denied: [] };
}

/** One NDJSON event of `agy --output-format stream-json`. */
export function onAgyEvent(ev: any, state: AgyState): { state: AgyState; events: AgentEvent[] } {
  const next = { ...state, denied: [...state.denied] };
  const events: AgentEvent[] = [];
  switch (ev.event) {
    case 'init':
      if (typeof ev.init?.conversation_id === 'string') next.sessionId = ev.init.conversation_id;
      break;
    case 'step_update': {
      const step = ev.step_update ?? {};
      if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
        next.streamed += step.text_delta;
        events.push({ kind: 'text_delta', content: step.text_delta });
      } else if (step.step_type === 'tool' && step.state === 'ACTIVE') {
        const params = step.tool_info?.parameters;
        const detail = params ? ` ${JSON.stringify(params).slice(0, 300)}` : '';
        events.push({ kind: 'tool', content: `${step.tool_name ?? 'tool'}${detail}` });
      }
      break;
    }
    case 'result': {
      const r = ev.result ?? {};
      next.status = r.status;
      if (typeof r.conversation_id === 'string') next.sessionId = r.conversation_id;
      if (typeof r.response === 'string') next.response = r.response;
      if (typeof r.error === 'string' && r.error) next.error = r.error;
      next.usage = agyUsage(r.usage);
      for (const d of Array.isArray(r.denied_actions) ? r.denied_actions : []) next.denied.push(String(d?.action ?? d?.display_name ?? 'action'));
      break;
    }
  }
  return { state: next, events };
}

export function agyError(state: AgyState, code: number, stderr: string): string | undefined {
  if (state.status && state.status !== 'SUCCESS') return state.error ?? `Antigravity trả trạng thái ${state.status}`;
  if (!state.status && code !== 0) return `agy exited with code ${code}: ${stderr.trim().slice(-1500)}`;
}

/** The reply text, or an explanation when headless mode denied the tool the agent needed. */
export function agyFinalText(state: AgyState): string {
  const text = (state.response ?? state.streamed).trim();
  if (text) return text;
  if (state.denied.length) {
    return `Antigravity không trả kết quả vì lượt chạy không tương tác bị từ chối quyền: ${[...new Set(state.denied)].join(', ')}. Thêm luật cho phép vào permissions.allow trong settings.json của agy, hoặc đặt --dangerously-skip-permissions trong extraArgs của Antigravity nếu bạn chấp nhận.`;
  }
  return '';
}

export const antigravity: AgentAdapter = {
  name: 'antigravity',
  async run(o: RunOptions): Promise<RunResult> {
    // Without --mode the CLI asks before editing or running commands; headless mode denies those asks, which keeps
    // read-only roles read-only. Only an edit turn accepts file edits on its own.
    const edits = o.permission === 'edit' || (o.permission === undefined && o.role === 'coder');
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (edits) args.push('--mode', 'accept-edits');
    if (o.sessionId) args.push('--conversation', o.sessionId);
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    // Saved extra arguments stay before -p; the prompt itself travels as a stream-json message on stdin.
    args.push(...(getCliSettingsSync().antigravity.extraArgs ?? []));
    args.push('-p=');

    let state = initialAgyState(o.sessionId);
    const bin = resolveBin('antigravity');
    await assertPlanOnly('antigravity', bin, o.cwd, { allowUnverifiedAuth: o.allowUnverifiedAuth });
    const { code, stderr } = await spawnJsonl(bin.cmd, [...bin.prefixArgs, ...args], {
      cwd: o.cwd,
      stdin: JSON.stringify({ event: 'user', message: { content: o.prompt } }) + '\n',
      signal: o.signal,
      timeoutMs: o.timeoutMs ?? 10 * 60_000,
      env: agentEnv(bin),
      onRawLine: (line) => o.onEvent({ kind: 'raw', content: line }),
      onJson: (ev) => {
        const result = onAgyEvent(ev, state);
        state = result.state;
        for (const event of result.events) o.onEvent(event);
      },
    });

    const error = agyError(state, code, stderr);
    if (error) throw new Error(error);
    return { finalText: agyFinalText(state), sessionId: state.sessionId, usage: state.usage };
  },
  check: (cwd) => checkAgent('antigravity', cwd),
};
