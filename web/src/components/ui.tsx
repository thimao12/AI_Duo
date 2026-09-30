import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronDown, LoaderCircle } from 'lucide-react';
import type { Run, Speaker, Usage, Verdict } from '../api.ts';

/* ---- Formatting ------------------------------------------------------------ */

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

/** e.g. "12.3k in (9.1k cache) · 450 out · $0.021" */
export function formatUsage(u: Usage): string {
  const cache = u.cachedInputTokens ? ` (${k(u.cachedInputTokens)} cache)` : '';
  const cost = u.costUsd !== undefined ? ` · $${u.costUsd.toFixed(3)}` : '';
  return `${k(u.inputTokens)} in${cache} · ${k(u.outputTokens)} out${cost}`;
}

/** Short form for tight spots: "13k tok · $0.02" */
export function formatUsageShort(u: Usage): string {
  const cost = u.costUsd !== undefined ? ` · $${u.costUsd.toFixed(2)}` : '';
  return `${k(u.inputTokens + u.outputTokens)} tok${cost}`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function timeAgo(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'vừa tạo';
  if (s < 3600) return `${Math.floor(s / 60)} phút`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} ngày`;
  return new Date(t).toLocaleDateString('vi-VN', { day: 'numeric', month: 'numeric' });
}

/** Last path segment of a Windows or POSIX path. */
export function basename(p: string): string {
  let end = p.length;
  while (end > 0 && (p[end - 1] === '/' || p[end - 1] === '\\')) end--;
  const parts = p.slice(0, end).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Thread title: the prompt's first markdown heading when it has one (long generated prompts
 * share a preamble but differ in their heading), else its first sentence, capped.
 */
export function titleOf(prompt: string): string {
  const lines = prompt.split('\n');
  let heading: string | undefined;
  for (const line of lines) {
    let hashes = 0;
    while (line[hashes] === '#') hashes++;
    if (hashes >= 1 && hashes <= 4 && /\s/.test(line[hashes] ?? '')) {
      heading = line.slice(hashes).trim();
      break;
    }
  }
  const source = heading ?? (lines.find((line) => line.trim()) ?? prompt);
  // Drop emphasis markers, but keep underscores inside words (snake_case).
  const text = source.replace(/[*`]/g, '').replace(/_+/g, (run, offset: number, original: string) =>
    /\w/.test(original[offset - 1] ?? '') && /\w/.test(original[offset + run.length] ?? '') ? run : '',
  ).trim();
  let sentence = text;
  if (!heading) {
    for (let index = 1; index < text.length; index++) {
      if ('.!?'.includes(text[index]) && (index + 1 === text.length || /\s/.test(text[index + 1]))) {
        sentence = text.slice(0, index + 1);
        break;
      }
    }
  }
  return sentence.length > 64 ? `${sentence.slice(0, 62).trimEnd()}…` : sentence;
}

/** Stable callback ref for inputs revealed by an explicit user action. */
export function useInputFocus<T extends HTMLElement>() {
  return useCallback((element: T | null) => { element?.focus(); }, []);
}

/** Re-render every second while `active`, for live elapsed timers. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/* ---- Vocabulary ------------------------------------------------------------ */

export const AGENT_LABEL: Record<Speaker, string> = { claude: 'Claude', codex: 'Codex', system: 'Điều phối', user: 'Bạn' };
export const AGENT_DOT: Record<Speaker, string> = { claude: 'bg-claude', codex: 'bg-codex', system: 'bg-faint', user: 'bg-faint' };
export const AGENT_TEXT: Record<Speaker, string> = { claude: 'text-claude-fg', codex: 'text-codex-fg', system: 'text-muted', user: 'text-muted' };

export const MODE_LABEL: Record<string, string> = { code: 'Code', plan: 'Plan', debate: 'Debate (cũ)', pair: 'Pair (cũ)' };

export const PHASE_LABEL: Record<string, string> = {
  info: 'Chuẩn bị',
  propose: 'Đề xuất ban đầu',
  critique: 'Review chéo',
  synthesize: 'Tổng hợp',
  code: 'Viết code',
  review: 'Review & test',
  fix: 'Sửa theo review',
  plan: 'Lập kế hoạch',
  'plan-review': 'Review kế hoạch',
  'plan-revise': 'Chỉnh kế hoạch',
};

const STATUS: Record<Run['status'], { label: string; cls: string }> = {
  running: { label: 'Đang chạy', cls: 'text-info' },
  done: { label: 'Xong', cls: 'text-ok' },
  error: { label: 'Lỗi', cls: 'text-danger' },
  cancelled: { label: 'Đã dừng', cls: 'text-muted' },
};

/* ---- Small components ------------------------------------------------------ */

export function AgentDot({ agent, className = '' }: { agent: Speaker; className?: string }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${AGENT_DOT[agent]} ${className}`} />;
}

export function Spinner({ className = 'size-3.5' }: { className?: string }) {
  return <LoaderCircle aria-hidden className={`shrink-0 animate-spin text-faint ${className}`} strokeWidth={2.2} />;
}

export function StatusText({ status }: { status: Run['status'] }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.cls}`}>
      {status === 'running' ? <Spinner className="size-3 text-info" /> : <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {s.label}
    </span>
  );
}

const VERDICT: Record<Verdict, { label: string; cls: string }> = {
  AGREE: { label: 'Đồng ý', cls: 'text-ok bg-ok/10 ring-ok/25' },
  APPROVE: { label: 'Approve', cls: 'text-ok bg-ok/10 ring-ok/25' },
  REVISE: { label: 'Cần sửa', cls: 'text-warn bg-warn/10 ring-warn/25' },
  CHANGES_REQUESTED: { label: 'Yêu cầu sửa', cls: 'text-warn bg-warn/10 ring-warn/25' },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict];
  return (
    <span title={verdict} className={`inline-flex items-center rounded-full px-2 py-px text-[11px] font-semibold ring-1 ring-inset ${v.cls}`}>
      {v.label}
    </span>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Agent output links to files and websites; never navigate the app itself away.
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-bg px-1 font-sans text-[11.5px] font-medium text-faint">{children}</kbd>;
}

/* ---- Popover / menu -------------------------------------------------------- */

/** Close on outside pointer-down and on Escape (focus returns to the trigger). */
function useDismiss(open: boolean, close: () => void, root: React.RefObject<HTMLElement | null>, trigger: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close, root, trigger]);
}

export const chipCls =
  'inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted transition-colors hover:bg-surface hover:text-fg aria-expanded:bg-surface aria-expanded:text-fg disabled:opacity-50';

interface PopoverProps {
  /** Contents of the trigger button. */
  label: ReactNode;
  title?: string;
  /** Opens upwards when the control sits at the bottom of the window. */
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  width?: string;
  showChevron?: boolean;
  triggerClassName?: string;
  children: (close: () => void) => ReactNode;
}

export function Popover({ label, title, side = 'top', align = 'start', width = 'w-64', showChevron = true, triggerClassName = chipCls, children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useDismiss(open, close, root, trigger);
  // Where the panel actually fits: flipped side, height cap and a horizontal nudge.
  const [fit, setFit] = useState<{ side: 'top' | 'bottom'; maxHeight: number; shift: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return setFit(null);
    const t = trigger.current.getBoundingClientRect();
    const margin = 12;
    const above = t.top - margin - 8;
    const below = window.innerHeight - t.bottom - margin - 8;
    const need = panel.current.scrollHeight;
    const preferred = side === 'top' ? above : below;
    const flipped = need > preferred && (side === 'top' ? below : above) > preferred;
    const finalSide = flipped ? (side === 'top' ? 'bottom' : 'top') : side;
    const space = finalSide === 'top' ? above : below;
    // Keep the panel inside the window horizontally.
    const p = panel.current.getBoundingClientRect();
    const shift = Math.max(margin - p.left, Math.min(0, window.innerWidth - margin - p.right));
    setFit({ side: finalSide, maxHeight: Math.max(160, space), shift });
  }, [open, side]);

  // Move focus into the panel so keyboard users land on the first option.
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>('button, input, [tabindex]')?.focus();
  }, [open]);

  const shownSide = fit?.side ?? side;

  return (
    <div ref={root} className="relative min-w-0">
      <button ref={trigger} type="button" title={title} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)} className={triggerClassName}>
        {label}
        {showChevron && <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />}
      </button>
      {open && (
        <div
          ref={panel}
          role="dialog"
          onKeyDown={(e) => {
            // Arrow-key navigation between options.
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role=menuitemradio], [role=menuitem]') ?? [])];
            if (!items.length) return;
            e.preventDefault();
            const i = items.indexOf(document.activeElement as HTMLElement);
            items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
          }}
          style={fit ? { maxHeight: fit.maxHeight, transform: fit.shift ? `translateX(${fit.shift}px)` : undefined } : { visibility: 'hidden' }}
          className={`absolute z-40 ${width} max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-line bg-bg p-1 shadow-pop ${shownSide === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'} ${align === 'end' ? 'right-0' : 'left-0'}`}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium text-faint">{children}</p>;
}

export function MenuItem({
  selected,
  onSelect,
  icon,
  label,
  hint,
}: {
  selected?: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <button
      type="button"
      role={selected === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={selected}
      onClick={onSelect}
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-fg transition-colors hover:bg-surface focus-visible:bg-surface focus-visible:outline-none"
    >
      {icon && <span className="mt-0.5 shrink-0 text-muted">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && <span className="mt-0.5 block text-[12px] leading-snug text-faint">{hint}</span>}
      </span>
      {selected && <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg" />}
    </button>
  );
}
