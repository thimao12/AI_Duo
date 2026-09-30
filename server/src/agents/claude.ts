import { agentEnv, assertPlanOnly, blockClaudeUntil, claudeOverageMessage } from './billing.ts';
import { resolveBin } from './bins.ts';
import { getCliSettingsSync } from '../settings.ts';
import { checkAgent } from './check.ts';
import { AbortedError, spawnJsonl } from './process.ts';
import type { AgentAdapter, AgentEvent, Role, RunOptions, RunResult, Usage } from './types.ts';

/** An explicit permission replaces the role's tier: edit = coder, read = reviewer (if it was one) or thinker. */
function tierFor(role: Role, permission?: 'read' | 'edit'): Role {
  if (permission === 'edit') return 'coder';
  if (permission === 'read') return role === 'reviewer' ? 'reviewer' : 'thinker';
  return role;
}

export function permissionArgs(role: Role, permission?: 'read' | 'edit'): string[] {
  switch (tierFor(role, permission)) {
    case 'coder':
      return ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Edit,Write,Read,Grep,Glob,TodoWrite'];
    case 'reviewer':
      return ['--allowedTools', 'Bash,Read,Grep,Glob', '--disallowedTools', 'Edit,Write,NotebookEdit'];
    case 'thinker':
    default:
      return ['--allowedTools', 'Read,Grep,Glob,WebSearch,WebFetch', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit'];
  }
}

function summarizeInput(input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  const s = JSON.stringify(input);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

function toolResultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

const WINDOW_LABEL: Record<string, string> = { five_hour: '5 giờ', seven_day: '7 ngày' };

const RATE_LIMIT_STATE = new Map([['rejected', 'đã chạm hạn mức'], ['allowed_warning', 'sắp chạm hạn mức']]);

/** e.g. "Quota Claude sắp chạm hạn mức: đã dùng 75% hạn mức 7 ngày, reset lúc 26/9 21:00" */
export function describeRateLimit(status: string, info: any): string {
  const window = WINDOW_LABEL[info.rateLimitType] ?? info.rateLimitType ?? '';
  const pct = typeof info.utilization === 'number' ? `${Math.round(info.utilization * 100)}% ` : '';
  const reset =
    typeof info.resetsAt === 'number'
      ? `, reset lúc ${new Date(info.resetsAt * 1000).toLocaleString('vi-VN', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : '';
  const state = RATE_LIMIT_STATE.get(status) ?? status;
  return `Quota Claude ${state}: đã dùng ${pct}hạn mức ${window}${reset}`.replace(/\s+/g, ' ');
}

export interface ClaudeJsonState {
  sessionId?: string;
  finalText?: string;
  streamed: string;
  errorText?: string;
  usage?: Usage;
  /** Claude switched to extra usage (billed beyond the plan); the turn must stop. */
  overage?: { resetsAt?: number };
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** The `result` event's usage counts cache writes/reads separately from fresh input. */
export function claudeUsage(ev: any): Usage | undefined {
  const u = ev?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const cached = num(u.cache_read_input_tokens);
  return {
    inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + cached,
    outputTokens: num(u.output_tokens),
    cachedInputTokens: cached,
    ...(typeof ev.total_cost_usd === 'number' && { costUsd: ev.total_cost_usd }),
  };
}

export function initialClaudeJsonState(sessionId?: string): ClaudeJsonState {
  return { sessionId, streamed: '' };
}

function onStreamEvent(ev: any, next: ClaudeJsonState, events: AgentEvent[]) {
  const d = ev.event?.delta;
  if (ev.event?.type === 'content_block_delta' && d?.type === 'text_delta' && d.text) {
    next.streamed += d.text;
    events.push({ kind: 'text_delta', content: d.text });
  } else if (ev.event?.type === 'content_block_start' && ev.event.content_block?.type === 'text' && next.streamed) {
    // new text block after a tool call: keep blocks visually separated
    next.streamed += '\n\n';
    events.push({ kind: 'text_delta', content: '\n\n' });
  }
}

function onToolResults(ev: any, events: AgentEvent[]) {
  for (const block of ev.message?.content ?? []) {
    if (block?.type !== 'tool_result') continue;
    const text = toolResultText(block.content);
    if (text) events.push({ kind: 'tool_result', content: text.length > 4000 ? text.slice(0, 4000) + '\n…' : text });
  }
}

function onResult(ev: any, next: ClaudeJsonState) {
  next.usage = claudeUsage(ev);
  if (ev.is_error) next.errorText = typeof ev.result === 'string' ? ev.result : `Claude error (${ev.subtype})`;
  else if (typeof ev.result === 'string') next.finalText = ev.result;
}

function onRateLimit(ev: any, next: ClaudeJsonState, events: AgentEvent[]) {
  const info = ev.rate_limit_info ?? {};
  const status = info.status ?? ev.status;
  // Only a reading with a utilization feeds the usage bar; a bare status would be an empty event.
  if (typeof info.utilization === 'number') events.push({ kind: 'raw', content: '', rateLimit: {
    type: info.rateLimitType,
    utilization: info.utilization,
    ...(typeof info.resetsAt === 'number' && { resetsAt: info.resetsAt }),
  } });
  if (info.isUsingOverage === true) {
    next.overage = { resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined };
    next.errorText = claudeOverageMessage(next.overage.resetsAt);
  } else if (status === 'rejected') next.errorText = `Claude rate limit rejected: ${JSON.stringify(info)}`;
  // 'allowed' arrives on nearly every turn; only surface warnings.
  else if (status !== 'allowed') events.push({ kind: 'raw', content: describeRateLimit(status, info) });
}

export function onJson(ev: any, state: ClaudeJsonState): { state: ClaudeJsonState; events: AgentEvent[] } {
  const next = { ...state };
  const events: AgentEvent[] = [];
  if (ev.session_id) next.sessionId = ev.session_id;
  const topLevel = !ev.parent_tool_use_id;

  if (ev.type === 'stream_event' && topLevel) onStreamEvent(ev, next, events);
  else if (ev.type === 'assistant') {
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'tool_use') events.push({ kind: 'tool', content: `${block.name}: ${summarizeInput(block.input)}` });
    }
  } else if (ev.type === 'user' && topLevel) onToolResults(ev, events);
  else if (ev.type === 'result') onResult(ev, next);
  else if (ev.type === 'rate_limit_event') onRateLimit(ev, next, events);
  return { state: next, events };
}

export const claude: AgentAdapter = {
  name: 'claude',
  async run(o: RunOptions): Promise<RunResult> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...permissionArgs(o.role, o.permission)];
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    if (o.sessionId) args.push('--resume', o.sessionId);
    // Saved extra arguments go last; the prompt travels through stdin, so nothing can displace it.
    args.push(...(getCliSettingsSync().claude.extraArgs ?? []));

    let state = initialClaudeJsonState(o.sessionId);

    const bin = resolveBin('claude');
    await assertPlanOnly('claude', bin, o.cwd, { allowUnverifiedAuth: o.allowUnverifiedAuth });
    // Our own abort, so extra usage can stop the CLI mid-turn; the run's cancel still flows through.
    const stop = new AbortController();
    const onCancel = () => stop.abort();
    o.signal.addEventListener('abort', onCancel);
    const { code, stderr } = await spawnJsonl(bin.cmd, [...bin.prefixArgs, ...args], {
      cwd: o.cwd,
      stdin: o.images?.length ? `${o.prompt}\n\nAttached images (use the Read tool to inspect them):\n${o.images.join('\n')}` : o.prompt,
      signal: stop.signal,
      timeoutMs: o.timeoutMs ?? 10 * 60_000,
      env: agentEnv(bin),
      onRawLine: (line) => o.onEvent({ kind: 'raw', content: line }),
      onJson: (ev) => {
        const result = onJson(ev, state);
        state = result.state;
        for (const event of result.events) o.onEvent(event);
        if (state.overage && !stop.signal.aborted) {
          blockClaudeUntil(state.overage.resetsAt);
          stop.abort();
        }
      },
    })
      .catch((err) => {
        // Stopped for extra usage, not by the user: report it as a failure, not a cancel.
        if (err instanceof AbortedError && state.overage && !o.signal.aborted) throw new Error(state.errorText);
        throw err;
      })
      .finally(() => o.signal.removeEventListener('abort', onCancel));

    if (state.errorText) throw new Error(state.errorText);
    if (state.finalText === undefined) {
      if (code !== 0) throw new Error(`claude exited with code ${code}: ${stderr.trim().slice(-1500)}`);
      state.finalText = state.streamed;
    }
    return { finalText: state.finalText, sessionId: state.sessionId, usage: state.usage };
  },
  check: (cwd) => checkAgent('claude', cwd),
};
