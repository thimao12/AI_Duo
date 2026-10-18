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
  /** Tools headless mode refused; from `denied_actions` when the CLI lists them (stderr is the main source). */
  denied: string[];
  /** A closing `result` event arrived. */
  finished: boolean;
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const id = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);

/** agy's `output_tokens` already counts thinking tokens; `cache_read_tokens` is the cached part of the input. */
export function agyUsage(u: any): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cachedInputTokens: num(u.cache_read_tokens) };
}

export function initialAgyState(sessionId?: string): AgyState {
  return { sessionId, streamed: '', denied: [], finished: false };
}

/**
 * One NDJSON event of `agy --output-format stream-json`. The conversation id comes from `init` (top level, as
 * documented, or nested in `init.init` as older versions wrote it) and is replaced by the one on `result`.
 */
export function onAgyEvent(ev: any, state: AgyState): { state: AgyState; events: AgentEvent[] } {
  const next = { ...state, denied: [...state.denied] };
  const events: AgentEvent[] = [];
  switch (ev?.event) {
    case 'init':
      next.sessionId = id(ev.conversation_id) ?? id(ev.init?.conversation_id) ?? next.sessionId;
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
      next.finished = true;
      next.status = typeof r.status === 'string' ? r.status : undefined;
      next.sessionId = id(r.conversation_id) ?? next.sessionId;
      if (typeof r.response === 'string') next.response = r.response;
      if (typeof r.error === 'string' && r.error) next.error = r.error;
      next.usage = agyUsage(r.usage);
      for (const d of Array.isArray(r.denied_actions) ? r.denied_actions : []) next.denied.push(String(d?.action ?? d?.display_name ?? 'action'));
      break;
    }
  }
  return { state: next, events };
}

// Headless mode refuses a tool that needs approval softly: the turn goes on, exits 0, and says so on stderr.
const DENIAL = /\b(denied|not approved|requires? approval|permission)\b/i;
const UNSUPPORTED_FLAG = /(unknown|unrecognized|invalid|unsupported)\b.*(flag|option|argument|value|mode)|--mode|--input-format|--output-format/i;

/** The stderr lines that report a refused tool, deduplicated, at most five. */
export function agyDenials(stderr: string): string[] {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && DENIAL.test(line));
  return [...new Set(lines)].slice(0, 5).map((line) => line.slice(0, 300));
}

const tail = (stderr: string) => stderr.trim().slice(-1500);

const AUTH_FAILURE = /not (logged|signed) in|unauthenticated|unauthori[sz]ed|\b401\b|(login|sign[- ]?in) (is )?required|please (log|sign) ?in|(credentials|token) (have |has )?expired/i;
export const AGY_LOGIN_HINT = 'Antigravity chưa đăng nhập hoặc phiên đăng nhập đã hết hạn. Chạy `agy` trong terminal và đăng nhập lại bằng tài khoản Google, rồi chạy lại.';

/**
 * Why the turn failed, or undefined. A non-zero exit fails even after a SUCCESS result; a stream without any
 * result (agy crashed, or printed something that was not stream-json) fails too.
 */
export function agyError(state: AgyState, code: number, stderr: string, mode?: 'plan' | 'accept-edits'): string | undefined {
  const failedStatus = Boolean(state.status && state.status !== 'SUCCESS');
  if ((failedStatus || code !== 0) && AUTH_FAILURE.test(`${state.error ?? ''}\n${stderr}`)) return `${AGY_LOGIN_HINT} (agy: ${(state.error ?? tail(stderr)).slice(0, 300)})`;
  if (failedStatus) return state.error ?? `Antigravity trả trạng thái ${state.status}`;
  if (code !== 0) {
    if (mode && !state.finished && UNSUPPORTED_FLAG.test(stderr))
      return `Phiên bản agy này không nhận chế độ headless AI Duo cần (--mode ${mode}, stream-json); AI Duo không chạy với ít bảo vệ hơn. Cập nhật Antigravity CLI. agy: ${tail(stderr)}`;
    return `agy exited with code ${code}${state.finished ? ' after its result' : ''}: ${tail(stderr) || 'no output on stderr'}`;
  }
  if (!state.finished) return `agy kết thúc mà không gửi kết quả (result) – output không phải stream-json hợp lệ hoặc lượt bị cắt ngang.${stderr.trim() ? ` stderr: ${tail(stderr)}` : ''}`;
}

/** The reply text, or an explanation when headless mode refused the tool the agent needed. */
export function agyFinalText(state: AgyState, denials: readonly string[] = []): string {
  const text = (state.response ?? state.streamed).trim();
  if (text) return text;
  const refused = [...new Set([...denials, ...state.denied])];
  if (refused.length) {
    return `Antigravity không trả kết quả vì lượt chạy không tương tác đã từ chối công cụ cần duyệt: ${refused.join('; ')}. Nếu công cụ đó an toàn, thêm luật cho phép tương ứng vào permissions.allow trong settings.json của agy rồi chạy lại.`;
  }
  return '';
}

/** Read turns plan only; edit turns accept file edits. Passed every time, so agy's own default never decides. */
export function agyMode(o: Pick<RunOptions, 'permission' | 'role'>): 'plan' | 'accept-edits' {
  const edits = o.permission === 'edit' || (o.permission === undefined && o.role === 'coder');
  return edits ? 'accept-edits' : 'plan';
}

/** Command-line arguments of one turn (the prompt goes on stdin). */
export function agyArgs(o: Pick<RunOptions, 'permission' | 'role' | 'sessionId' | 'model' | 'effort'>, extraArgs: readonly string[] = []): string[] {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', agyMode(o)];
  if (o.sessionId) args.push('--conversation', o.sessionId);
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  // Saved extra arguments stay before -p; settings validation keeps them off the flags above.
  args.push(...extraArgs, '-p=');
  return args;
}

/** stream-json input accepts text blocks only, so attached images cannot be passed on. */
export const AGY_IMAGES_UNSUPPORTED =
  'Antigravity CLI ở chế độ headless (stream-json) chỉ nhận văn bản, chưa nhận ảnh đính kèm. Bỏ ảnh khỏi tin nhắn, hoặc chọn Claude/Codex cho lượt có ảnh.';

export const antigravity: AgentAdapter = {
  name: 'antigravity',
  async run(o: RunOptions): Promise<RunResult> {
    // Refused before anything starts: never drop the images and answer as if they had been read.
    if (o.images?.length) throw new Error(AGY_IMAGES_UNSUPPORTED);
    const mode = agyMode(o);
    const args = agyArgs(o, getCliSettingsSync().antigravity.extraArgs ?? []);

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

    const error = agyError(state, code, stderr, mode);
    if (error) throw new Error(error);
    const denials = agyDenials(stderr);
    if (denials.length) o.onEvent({ kind: 'error', content: `Antigravity (headless) đã từ chối: ${denials.join('; ')}` });
    return { finalText: agyFinalText(state, denials), sessionId: state.sessionId, usage: state.usage };
  },
  check: (cwd) => checkAgent('antigravity', cwd),
};
