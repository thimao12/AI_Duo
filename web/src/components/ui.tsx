import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Run, Speaker, Usage, Verdict } from '../api.ts';

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

/** e.g. "12.3k in (9.1k cache) · 450 out · $0.021" */
export function formatUsage(u: Usage): string {
  const cache = u.cachedInputTokens ? ` (${k(u.cachedInputTokens)} cache)` : '';
  const cost = u.costUsd !== undefined ? ` · $${u.costUsd.toFixed(3)}` : '';
  return `${k(u.inputTokens)} in${cache} · ${k(u.outputTokens)} out${cost}`;
}

export const AGENT_LABEL: Record<Speaker, string> = { claude: 'Claude', codex: 'Codex', system: 'Orchestrator' };

export const AGENT_STYLE: Record<Speaker, { dot: string; text: string }> = {
  claude: { dot: 'bg-claude', text: 'text-claude' },
  codex: { dot: 'bg-codex', text: 'text-codex' },
  system: { dot: 'bg-zinc-500', text: 'text-zinc-400' },
};

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

const VERDICT_STYLE: Record<Verdict, string> = {
  AGREE: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  APPROVE: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  REVISE: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  CHANGES_REQUESTED: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide ring-1 ${VERDICT_STYLE[verdict]}`}>
      {verdict.replace('_', ' ')}
    </span>
  );
}

const STATUS_STYLE: Record<Run['status'], string> = {
  running: 'bg-sky-500/15 text-sky-300',
  done: 'bg-emerald-500/15 text-emerald-300',
  error: 'bg-red-500/15 text-red-300',
  cancelled: 'bg-zinc-500/20 text-zinc-300',
};

export function StatusBadge({ status }: { status: Run['status'] }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>
      {status === 'running' && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {status}
    </span>
  );
}

export function Spinner() {
  return <span className="inline-block size-3 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-200" />;
}
