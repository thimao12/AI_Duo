import type { Usage } from '../../server/src/agents/types.ts';
import type { Message, Run, RunEvent, Speaker } from '../../server/src/types.ts';

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  magenta(s: string): string;
}

/** Colours only when writing to a terminal and NO_COLOR is unset. */
export function makeStyle(enabled: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39), magenta: wrap(35, 39) };
}

const NAMES: Record<Speaker, string> = { claude: 'Claude', codex: 'Codex', system: 'AI Duo', user: 'Bạn' };

function tint(style: Style, agent: Speaker, text: string) {
  return agent === 'claude' ? style.yellow(text) : agent === 'codex' ? style.green(text) : agent === 'user' ? style.magenta(text) : style.cyan(text);
}

export function speaker(style: Style, agent: Speaker) {
  return tint(style, agent, NAMES[agent]);
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function formatUsage(usage?: Usage) {
  if (!usage) return '';
  const cost = usage.costUsd !== undefined ? ` · $${usage.costUsd.toFixed(2)}` : '';
  return `${k(usage.inputTokens)} in / ${k(usage.outputTokens)} out${cost}`;
}

function duration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

const indent = (text: string, prefix = '  ') => text.replace(/\n$/, '').split('\n').map((line) => prefix + line).join('\n');

export interface RendererOptions {
  style: Style;
  /** Tool output and raw CLI lines too. */
  verbose: boolean;
}

/** Streams RunEvents as readable progress (to stderr, so stdout carries only the result). */
export class ProgressRenderer {
  private messages = new Map<string, Message>();
  /** Message whose text is being streamed; another message's output starts a new header. */
  private streaming?: string;
  private atLineStart = true;

  constructor(
    private readonly write: (s: string) => void,
    private readonly options: RendererOptions,
  ) {}

  private out(s: string) {
    if (!s) return;
    this.write(s);
    this.atLineStart = s.endsWith('\n');
  }

  private line(s: string) {
    if (!this.atLineStart) this.out('\n');
    this.out(`${s}\n`);
  }

  private header(m: Message) {
    const { style } = this.options;
    const model = m.model ? style.dim(` · ${m.model}`) : '';
    // Agent turn titles already name the agent ("Codex implements"); colour marks who is speaking.
    this.line(`\n${style.bold('▸')} ${style.bold(tint(style, m.agent, m.title))}${model}`);
    this.streaming = m.id;
  }

  private focus(id: string) {
    const m = this.messages.get(id);
    if (m && this.streaming !== id) this.header(m);
  }

  event(e: RunEvent) {
    const { style, verbose } = this.options;
    switch (e.type) {
      case 'message.start': {
        this.messages.set(e.message.id, e.message);
        if (e.message.agent === 'user') {
          this.line(`\n${style.bold('›')} ${speaker(style, 'user')}: ${e.message.parts[0]?.content.split('\n')[0] ?? ''}`);
          this.streaming = undefined;
        } else if (e.message.agent !== 'system') this.header(e.message);
        break;
      }
      case 'message.event': {
        const m = this.messages.get(e.id);
        const ev = e.event;
        if (m?.agent === 'system') {
          // Orchestrator notes arrive as one text event between start and end.
          if (ev.kind === 'text') this.line(`\n${style.cyan('ℹ')} ${style.bold(m.title)}\n${style.dim(indent(ev.content))}`);
          this.streaming = undefined;
          break;
        }
        if (ev.kind === 'text_delta' || ev.kind === 'text') {
          this.focus(e.id);
          this.out(ev.kind === 'text' && !this.atLineStart ? `\n${ev.content}` : ev.content);
        } else if (ev.kind === 'tool') {
          this.focus(e.id);
          this.line(style.dim(`  $ ${ev.content.split('\n')[0].slice(0, 200)}`));
        } else if (ev.kind === 'tool_result') {
          if (!verbose) break;
          this.focus(e.id);
          this.line(style.dim(indent(ev.content.slice(0, 2000), '    ')));
        } else if (ev.kind === 'error') {
          this.focus(e.id);
          this.line(style.red(indent(ev.content, '  ✗ ')));
        } else if (ev.kind === 'raw' && ev.content && (verbose || !ev.content.startsWith('{'))) {
          this.focus(e.id);
          this.line(style.dim(`  ${ev.content.slice(0, 500)}`));
        }
        break;
      }
      case 'message.end': {
        const m = this.messages.get(e.id);
        if (!m || m.agent === 'system' || m.agent === 'user') break;
        const mark = e.status === 'done' ? style.green('✓') : style.red('✗');
        const verdict = e.verdict ? ` · ${e.verdict === 'APPROVE' || e.verdict === 'AGREE' ? style.green(e.verdict) : style.yellow(e.verdict)}` : '';
        const usage = e.usage ? ` · ${formatUsage(e.usage)}` : '';
        this.line(style.dim(`  ${mark} ${NAMES[m.agent]} · ${duration(e.endedAt - m.startedAt)}${usage}`) + verdict);
        this.streaming = undefined;
        break;
      }
      case 'run.update':
      case 'snapshot':
        break;
    }
  }

  /** Put the cursor on a fresh line before another component writes (decision prompts). */
  flush() {
    if (!this.atLineStart) this.out('\n');
    this.streaming = undefined;
  }
}

/** Whole saved run as text, for `ai-duo show`. */
export function transcript(run: Run, style: Style, { verbose = false } = {}) {
  const out: string[] = [];
  out.push(`${style.bold(run.title || run.config.prompt.split('\n')[0].slice(0, 100))}`);
  out.push(style.dim(`${run.id} · ${run.config.mode} · ${run.status} · ${new Date(run.createdAt).toLocaleString()} · ${run.config.cwd}`));
  if (run.error) out.push(style.red(`Error: ${run.error}`));
  for (const m of run.messages) {
    const model = m.model ? style.dim(` · ${m.model}`) : '';
    const mark = m.status === 'error' ? style.red(' ✗') : m.verdict ? ` · ${m.verdict}` : '';
    const title = m.agent === 'claude' || m.agent === 'codex' ? m.title : `${NAMES[m.agent]} · ${m.title}`;
    out.push('', `${style.bold('▸')} ${style.bold(tint(style, m.agent, title))}${model}${mark}`);
    for (const part of m.parts) {
      if (part.kind === 'text') out.push(indent(part.content));
      else if (part.kind === 'tool') out.push(style.dim(`  $ ${part.content.split('\n')[0].slice(0, 200)}`));
      else if (part.kind === 'error') out.push(style.red(indent(part.content, '  ✗ ')));
      else if (verbose && part.content) out.push(style.dim(indent(part.content.slice(0, 2000), '    ')));
    }
  }
  if (run.final) out.push('', style.bold('── Kết quả ──'), run.final);
  return `${out.join('\n')}\n`;
}
