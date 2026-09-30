import { useState } from 'react';
import { ChevronRight, CircleAlert, FilePen, FileText, Info, Search, SquareTerminal, Waypoints, Wrench } from 'lucide-react';
import type { AgentName, Message, Part } from '../api.ts';
import { AgentDot, AGENT_LABEL, AGENT_TEXT, formatDuration, formatUsage, formatUsageShort, Markdown, Spinner, useNow, VerdictBadge } from './ui.tsx';
import { verdictBody } from '../../../shared/text.ts';

/** Strip the machine-readable trailer the prompts ask for; it's shown as a badge instead. */
export function cleanText(text: string) {
  const trimmed = text.trimEnd();
  let start = -1;
  for (const marker of trimmed.matchAll(/VERDICT:/gi)) start = marker.index;
  if (start < 0) return trimmed;
  const body = verdictBody(trimmed.slice(start + 'VERDICT:'.length));
  const verdict = ['AGREE', 'REVISE'].find((value) => body.toUpperCase().startsWith(value));
  if (!verdict) return trimmed;
  let end = verdict.length;
  while (body[end] === '*') end++;
  if (body[end] === '`') end++;
  if (body.slice(end).trim()) return trimmed;
  if (trimmed[start - 1] === '`') start--;
  return trimmed.slice(0, start).trimEnd();
}

const other = (a: AgentName): AgentName => (a === 'claude' ? 'codex' : 'claude');

/** What this turn is, in the user's language (the server's titles are English and verbose). */
export function turnLabel(m: Message): string {
  const a = m.agent === 'system' || m.agent === 'user' ? null : m.agent;
  switch (m.phase) {
    case 'propose':
      return 'Đề xuất';
    case 'critique':
      return a ? `Review đề xuất của ${AGENT_LABEL[other(a)]}` : 'Review chéo';
    case 'synthesize':
      return 'Viết giải pháp cuối';
    case 'code':
      return 'Viết code';
    case 'review':
      return 'Review & chạy test';
    case 'fix':
      return 'Sửa theo review';
    default:
      return m.title;
  }
}

/* ---- Tool calls ------------------------------------------------------------ */

type ToolKind = 'run' | 'read' | 'search' | 'edit' | 'other';
interface ToolCall {
  kind: ToolKind;
  label: string;
  files: number;
  output?: string;
  exit?: number;
}

/** Codex wraps shell commands in `powershell.exe -Command '…'`; show the command itself. */
function unwrapShell(cmd: string): string {
  const m = cmd.match(/-Command\s+(['"])([\s\S]*)\1\s*$/);
  return (m ? m[2] : cmd).replace(/''/g, "'").trim();
}

function parseTool(part: Part, result?: Part): ToolCall {
  const [head, ...rest] = part.content.split('\n');
  const i = head.indexOf(':');
  const name = i > 0 ? head.slice(0, i) : head;
  const arg = i > 0 ? head.slice(i + 1).trim() : '';
  let output = result?.content;
  let exit: number | undefined;
  const ex = output?.match(/^exit (-?\d+)\n?/);
  if (ex) {
    exit = Number(ex[1]);
    output = output!.slice(ex[0].length);
  }
  if (/^(Bash|Shell)$/.test(name)) return { kind: 'run', label: unwrapShell(arg), files: 0, output, exit };
  if (name === 'Read') return { kind: 'read', label: arg, files: 1, output };
  if (/^(Grep|Glob|WebSearch|WebFetch)$/.test(name)) return { kind: 'search', label: `${name} ${arg}`, files: 0, output };
  if (name === 'Edit files') {
    const files = rest.filter(Boolean);
    return { kind: 'edit', label: files.map((f) => f.replace(/^(\w+)\s+/, '')).join(', '), files: files.length, output };
  }
  if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(name)) return { kind: 'edit', label: arg, files: 1, output };
  return { kind: 'other', label: head, files: 0, output };
}

const TOOL_ICON: Record<ToolKind, typeof Wrench> = { run: SquareTerminal, read: FileText, search: Search, edit: FilePen, other: Wrench };

function summarize(calls: ToolCall[]): string {
  const n = (k: ToolKind) => calls.filter((c) => c.kind === k);
  const out: string[] = [];
  const run = n('run').length;
  const read = n('read').length;
  const search = n('search').length;
  const edited = n('edit').reduce((s, c) => s + c.files, 0);
  const other = n('other').length;
  if (run) out.push(`chạy ${run} lệnh`);
  if (read) out.push(`đọc ${read} file`);
  if (search) out.push(`tìm ${search} lần`);
  if (edited) out.push(`sửa ${edited} file`);
  if (other) out.push(`${other} công cụ khác`);
  const s = out.join(' · ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICON[call.kind];
  const failed = call.exit !== undefined && call.exit !== 0;
  const hasOutput = !!call.output?.trim();
  return (
    <li>
      <button
        type="button"
        disabled={!hasOutput}
        aria-expanded={hasOutput ? open : undefined}
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-muted transition-colors enabled:hover:bg-surface enabled:hover:text-fg"
      >
        <Icon aria-hidden className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{call.label || '…'}</span>
        {failed && <span className="shrink-0 font-mono text-[11px] text-danger">exit {call.exit}</span>}
        {hasOutput && <ChevronRight aria-hidden className={`size-3.5 shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />}
      </button>
      {open && hasOutput && (
        <pre className="mx-2 mt-1 mb-2 max-h-64 overflow-auto rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">
          {call.output!.trim()}
        </pre>
      )}
    </li>
  );
}

function ToolGroup({ calls, live }: { calls: ToolCall[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const last = calls[calls.length - 1];
  const failures = calls.filter((c) => c.exit !== undefined && c.exit !== 0).length;
  return (
    <div className="-mx-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] text-muted transition-colors hover:bg-surface hover:text-fg"
      >
        {live ? <Spinner className="size-3.5" /> : <Wrench aria-hidden className="size-3.5 shrink-0 text-faint" />}
        <span className="truncate">{summarize(calls)}</span>
        {failures > 0 && <span className="shrink-0 text-[12px] text-danger">· {failures} lệnh lỗi</span>}
        <ChevronRight aria-hidden className={`size-3.5 shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {!open && live && last && (
        <p className="truncate pl-7 font-mono text-[12px] text-faint">{last.label}</p>
      )}
      {open && <ul className="mt-0.5 border-l border-line pl-2 ml-3.5">{calls.map((c, i) => <ToolRow key={i} call={c} />)}</ul>}
    </div>
  );
}

/* ---- Blocks ---------------------------------------------------------------- */

type Block = { type: 'text'; text: string } | { type: 'tools'; calls: ToolCall[] } | { type: 'error'; text: string } | { type: 'note'; text: string };

function toBlocks(parts: Part[]): Block[] {
  const blocks: Block[] = [];
  // Parallel tool calls arrive as call, call, result, result: match results to calls in order.
  let pending: { part: Part; result?: Part }[] = [];
  let group: { part: Part; result?: Part }[] | null = null;
  // Notes (e.g. quota warnings) can land between a call and its result; show them after the group.
  let deferred: Block[] = [];
  const flush = () => {
    if (group?.length) blocks.push({ type: 'tools', calls: group.map((c) => parseTool(c.part, c.result)) });
    blocks.push(...deferred);
    group = null;
    pending = [];
    deferred = [];
  };
  for (const p of parts) {
    if (p.kind === 'tool') {
      group ??= [];
      const entry = { part: p };
      group.push(entry);
      pending.push(entry);
    } else if (p.kind === 'tool_result') {
      group ??= [];
      const target = pending.shift();
      if (target) target.result = p;
      else group.push({ part: { kind: 'tool', content: 'Kết quả công cụ' }, result: p });
    } else if (p.kind === 'text') {
      flush();
      const text = cleanText(p.content);
      if (text) blocks.push({ type: 'text', text });
    } else if (p.kind === 'error') {
      flush();
      blocks.push({ type: 'error', text: p.content });
    } else if (p.content.trim()) {
      if (group) deferred.push({ type: 'note', text: p.content });
      else blocks.push({ type: 'note', text: p.content });
    }
  }
  flush();
  return blocks;
}

function excerpt(blocks: Block[]): string {
  const text = [...blocks].reverse().find((b) => b.type === 'text') as { text: string } | undefined;
  return (text?.text ?? '')
    .replace(/[#*_`>|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

/* ---- Turn ------------------------------------------------------------------ */

/** Runs saved before the server spoke Vietnamese still carry these English notes. */
const LEGACY_NOTES: Record<string, (text: string) => [string, string]> = {
  'Baseline captured': (t) => ['Đã chụp trạng thái ban đầu', `Snapshot working tree${t.match(/\(tree \w+\)/)?.[0].replace('(tree', ' (tree') ?? ''}. Diff cuối phiên chỉ gồm thay đổi của agent. Không có gì được commit.`],
  'Consensus reached': (t) => ['Đã đồng thuận', `Cả hai agent đồng ý sau vòng ${t.match(/round (\d+)/)?.[1] ?? '?'}.`],
  'No full consensus': (t) => ['Chưa đồng thuận hoàn toàn', `Dừng sau ${t.match(/after (\d+)/)?.[1] ?? '?'} vòng; người chốt sẽ xử lý các điểm còn khác nhau.`],
};

export function SystemNote({ message: m }: { message: Message }) {
  const Icon = m.title.startsWith('Định tuyến') ? Waypoints : Info;
  const raw = m.parts.map((p) => p.content).join(' ');
  const [title, text] = LEGACY_NOTES[m.title]?.(raw) ?? [m.title, raw];
  return (
    <div className="flex gap-2.5 text-[12.5px] leading-relaxed text-muted">
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-faint" />
      <div className="min-w-0 whitespace-pre-line">
        <span className="font-medium text-fg">{title}.</span> {text}
        {m.usage && <span className="block font-mono text-[11.5px] text-faint">{formatUsage(m.usage)}</span>}
      </div>
    </div>
  );
}

export default function Turn({ message: m, compact }: { message: Message; compact: boolean }) {
  const running = m.status === 'running';
  const now = useNow(running);
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? !compact;
  const blocks = toBlocks(m.parts);
  const lastIndex = blocks.length - 1;
  const agent = m.agent as AgentName;

  return (
    <article aria-label={`${AGENT_LABEL[agent]}: ${turnLabel(m)}`} className="group/turn">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-surface"
      >
        <AgentDot agent={agent} />
        <span className={`text-[13.5px] font-semibold ${AGENT_TEXT[agent]}`}>{AGENT_LABEL[agent]}</span>
        <span className="min-w-0 truncate text-[13px] text-muted">{turnLabel(m)}</span>
        {m.verdict && <VerdictBadge verdict={m.verdict} />}
        <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2 text-[12px] text-faint">
          {m.model && <span className="hidden font-mono text-[11.5px] md:inline">{m.model}</span>}
          {m.usage && (
            <span className="hidden font-mono text-[11.5px] lg:inline" title={formatUsage(m.usage)}>
              {formatUsageShort(m.usage)}
            </span>
          )}
          {m.status === 'error' && <span className="font-medium text-danger">Lỗi</span>}
          {running && <Spinner className="size-3.5" />}
          <span className="tabular-nums">{formatDuration((m.endedAt ?? now) - m.startedAt)}</span>
          <ChevronRight aria-hidden className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        </span>
      </button>

      {!open ? (
        excerpt(blocks) && <p className="mt-0.5 line-clamp-2 pl-4 text-[13px] leading-relaxed text-muted">{excerpt(blocks)}</p>
      ) : (
        <div className="mt-1.5 space-y-2.5 pl-4">
          {blocks.length === 0 && running && <p className="thinking text-[13.5px]">Đang suy nghĩ…</p>}
          {blocks.map((b, i) =>
            b.type === 'text' ? (
              <Markdown key={i}>{b.text}</Markdown>
            ) : b.type === 'tools' ? (
              <ToolGroup key={i} calls={b.calls} live={running && i === lastIndex} />
            ) : b.type === 'error' ? (
              <p key={i} role="alert" className="flex gap-2 rounded-lg bg-danger/8 px-3 py-2 text-[12.5px] text-danger">
                <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 font-mono whitespace-pre-wrap">{b.text}</span>
              </p>
            ) : (
              <p key={i} className="flex gap-1.5 text-[12px] text-faint">
                <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{b.text}</span>
              </p>
            ),
          )}
          {running && blocks.length > 0 && blocks[lastIndex].type === 'text' && <p className="thinking text-[13px]">Đang làm tiếp…</p>}
        </div>
      )}
    </article>
  );
}
