import { resolveBin } from './bins.ts';
import { spawnJsonl } from './process.ts';
import type { AgentAdapter, AgentEvent, Role, RunOptions, RunResult, Usage } from './types.ts';

function permissionArgs(role: Role): string[] {
  switch (role) {
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

/** e.g. "⚠ Claude quota: đã dùng 75% hạn mức 7 ngày, reset lúc 26/9 21:00" */
export function describeRateLimit(status: string, info: any): string {
  const window = WINDOW_LABEL[info.rateLimitType] ?? info.rateLimitType ?? '';
  const pct = typeof info.utilization === 'number' ? `${Math.round(info.utilization * 100)}% ` : '';
  const reset =
    typeof info.resetsAt === 'number'
      ? `, reset lúc ${new Date(info.resetsAt * 1000).toLocaleString('vi-VN', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : '';
  return `⚠ Claude quota (${status}): đã dùng ${pct}hạn mức ${window}${reset}`.replace(/\s+/g, ' ');
}

export interface ClaudeJsonState {
  sessionId?: string;
  finalText?: string;
  streamed: string;
  errorText?: string;
  usage?: Usage;
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

export function onJson(ev: any, state: ClaudeJsonState): { state: ClaudeJsonState; events: AgentEvent[] } {
  const next = { ...state };
  const events: AgentEvent[] = [];
  if (ev.session_id) next.sessionId = ev.session_id;
  const topLevel = !ev.parent_tool_use_id;

  if (ev.type === 'stream_event' && topLevel) {
    const d = ev.event?.delta;
    if (ev.event?.type === 'content_block_delta' && d?.type === 'text_delta' && d.text) {
      next.streamed += d.text;
      events.push({ kind: 'text_delta', content: d.text });
    } else if (ev.event?.type === 'content_block_start' && ev.event.content_block?.type === 'text' && next.streamed) {
      // new text block after a tool call: keep blocks visually separated
      next.streamed += '\n\n';
      events.push({ kind: 'text_delta', content: '\n\n' });
    }
  } else if (ev.type === 'assistant') {
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'tool_use') events.push({ kind: 'tool', content: `${block.name}: ${summarizeInput(block.input)}` });
    }
  } else if (ev.type === 'user' && topLevel) {
    for (const block of ev.message?.content ?? []) {
      if (block?.type === 'tool_result') {
        const text = toolResultText(block.content);
        if (text) events.push({ kind: 'tool_result', content: text.length > 4000 ? text.slice(0, 4000) + '\n…' : text });
      }
    }
  } else if (ev.type === 'result') {
    next.usage = claudeUsage(ev);
    if (ev.is_error) next.errorText = typeof ev.result === 'string' ? ev.result : `Claude error (${ev.subtype})`;
    else if (typeof ev.result === 'string') next.finalText = ev.result;
  } else if (ev.type === 'rate_limit_event') {
    const info = ev.rate_limit_info ?? {};
    const status = info.status ?? ev.status;
    if (status === 'rejected') next.errorText = `Claude rate limit rejected: ${JSON.stringify(info)}`;
    // 'allowed' arrives on nearly every turn; only surface warnings.
    else if (status !== 'allowed') events.push({ kind: 'raw', content: describeRateLimit(status, info) });
  }
  return { state: next, events };
}

export const claude: AgentAdapter = {
  name: 'claude',
  async run(o: RunOptions): Promise<RunResult> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...permissionArgs(o.role)];
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    if (o.sessionId) args.push('--resume', o.sessionId);

    let state = initialClaudeJsonState(o.sessionId);

    const bin = resolveBin('claude');
    const { code, stderr } = await spawnJsonl(bin.cmd, [...bin.prefixArgs, ...args], {
      cwd: o.cwd,
      stdin: o.prompt,
      signal: o.signal,
      timeoutMs: o.timeoutMs ?? 10 * 60_000,
      env: bin.env ? { ...process.env, ...bin.env } : undefined,
      onRawLine: (line) => o.onEvent({ kind: 'raw', content: line }),
      onJson: (ev) => {
        const result = onJson(ev, state);
        state = result.state;
        for (const event of result.events) o.onEvent(event);
      },
    });

    if (state.errorText) throw new Error(state.errorText);
    if (state.finalText === undefined) {
      if (code !== 0) throw new Error(`claude exited with code ${code}: ${stderr.trim().slice(-1500)}`);
      state.finalText = state.streamed;
    }
    return { finalText: state.finalText, sessionId: state.sessionId, usage: state.usage };
  },
};
