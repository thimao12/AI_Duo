import type { Usage } from '../../../server/src/agents/types.ts';
import type { Message, Run } from '../../../server/src/types.ts';

/** One entry of the finished part of the thread (printed once, never repainted). */
export type ThreadItem =
  | { id: string; kind: 'header'; cwd: string; branch?: string; version: string }
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'message'; message: Message; effort?: string }
  | { id: string; kind: 'summary'; run: Run }
  | { id: string; kind: 'notice'; tone: 'info' | 'warn' | 'error'; text: string };

/** The previous turn's result is echoed as a system message on follow-ups; the thread already shows it. */
const isResultEcho = (m: Message) => m.agent === 'system' && m.phase === 'result';

function isHidden(m: Message, withUser: boolean): boolean {
  if (isResultEcho(m)) return true;
  return m.agent === 'user' && !withUser;
}

/**
 * Messages that finished since the last call, in order. A running message blocks the ones after it, so
 * the printed thread never reorders. `withUser` keeps user messages (a resumed run has no local echo).
 */
export function commitFinished(messages: readonly Message[], committed: Set<string>, withUser = false): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (committed.has(m.id)) continue;
    if (m.status === 'running') break;
    committed.add(m.id);
    if (!isHidden(m, withUser)) out.push(m);
  }
  return out;
}

/** Messages still being written (not yet printed). */
export function liveMessages(messages: readonly Message[], committed: ReadonlySet<string>): Message[] {
  return messages.filter((m) => !committed.has(m.id) && !isHidden(m, false));
}

/** Reasoning effort shown next to an agent: the run's manual setting, else the router's pick. */
export function effortFor(run: Run, message: Message): string | undefined {
  if (message.agent === 'user' || message.agent === 'system') return undefined;
  const manual = run.config.efforts?.[message.agent];
  if (manual) return manual;
  const choices = run.config.route?.models[message.agent];
  return choices ? Object.values(choices).find((c) => c?.effort)?.effort : undefined;
}

export interface DiffSummary {
  files: string[];
  added: number;
  removed: number;
}

/** The new path of a "diff --git a/x b/x" header. */
function diffPath(header: string): string {
  const rest = header.slice('diff --git a/'.length);
  const split = rest.lastIndexOf(' b/');
  return split < 0 ? rest : rest.slice(split + 3);
}

export function summarizeDiff(diff: string | undefined): DiffSummary {
  const files: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of (diff ?? '').split('\n')) {
    if (line.startsWith('diff --git a/')) files.push(diffPath(line));
    else if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { files, added, removed };
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function formatUsageLine(usage?: Usage): string {
  if (!usage) return '';
  const cost = usage.costUsd === undefined ? '' : ` · $${usage.costUsd.toFixed(2)}`;
  return `${k(usage.inputTokens)} in / ${k(usage.outputTokens)} out${cost}`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** First line of a tool call, clipped to `max` characters. */
export function oneLine(text: string, max: number): string {
  const first = text.split('\n')[0] ?? '';
  return first.length > max ? `${first.slice(0, Math.max(1, max - 1))}…` : first;
}

/** The last `maxLines` lines of a streaming text, so the live area never outgrows the terminal. */
export function tailLines(text: string, maxLines: number): { text: string; hidden: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, hidden: 0 };
  return { text: lines.slice(-maxLines).join('\n'), hidden: lines.length - maxLines };
}

export function clipLines(text: string, maxLines: number): { text: string; hidden: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, hidden: 0 };
  return { text: lines.slice(0, maxLines).join('\n'), hidden: lines.length - maxLines };
}
