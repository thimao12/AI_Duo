import { useEffect, useRef, useState } from 'react';
import { api, useRun, type Message } from './api.ts';
import DiffView from './components/DiffView.tsx';
import MessageCard from './components/MessageCard.tsx';
import { AGENT_LABEL, Markdown, StatusBadge } from './components/ui.tsx';

const PHASE_LABEL: Record<string, string> = {
  info: 'Chuẩn bị',
  propose: 'Đề xuất ban đầu',
  critique: 'Review chéo',
  synthesize: 'Tổng hợp',
  code: 'Code',
  review: 'Review & test',
  fix: 'Sửa theo review',
};

/** Consecutive messages of the same phase+round form a group; parallel turns render side by side. */
function group(messages: Message[]) {
  const groups: { key: string; phase: string; round: number; items: Message[] }[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (last && last.phase === m.phase && last.round === m.round) last.items.push(m);
    else groups.push({ key: m.id, phase: m.phase, round: m.round, items: [m] });
  }
  return groups;
}

export default function RunView({ id }: { id: string }) {
  const { run, error } = useRun(id);
  const [tab, setTab] = useState<'final' | 'diff'>('final');
  const [follow, setFollow] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);

  const running = run?.status === 'running';
  const lastLen = run?.messages.at(-1)?.parts.reduce((n, p) => n + p.content.length, 0);
  useEffect(() => {
    if (follow && running) bottom.current?.scrollIntoView({ block: 'end' });
  }, [follow, running, run?.messages.length, lastLen]);

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>;
  if (!run) return <p className="p-8 text-sm text-zinc-500">Đang tải…</p>;

  const { config } = run;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 sm:px-8">
      <header className="sticky top-0 z-10 -mx-4 border-b border-zinc-800 bg-zinc-950/95 px-4 py-4 backdrop-blur sm:-mx-8 sm:px-8">
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-medium tracking-wide text-zinc-300 uppercase">{config.mode}</span>
          <StatusBadge status={run.status} />
          <span>
            {config.mode === 'debate'
              ? `judge: ${AGENT_LABEL[config.judge]}`
              : `coder: ${AGENT_LABEL[config.coder]} · reviewer: ${AGENT_LABEL[config.coder === 'claude' ? 'codex' : 'claude']}`}
            {' · '}tối đa {config.maxRounds} vòng
          </span>
          <span className="truncate font-mono">{config.cwd}</span>
          <div className="ml-auto flex items-center gap-3">
            {running && (
              <>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-zinc-400" />
                  auto-scroll
                </label>
                <button
                  onClick={() => api.cancel(run.id)}
                  className="rounded-md border border-red-500/40 px-2.5 py-1 text-red-300 transition hover:bg-red-500/10"
                >
                  Dừng
                </button>
              </>
            )}
          </div>
        </div>
        <p className="mt-2 line-clamp-3 text-sm whitespace-pre-wrap text-zinc-200">{config.prompt}</p>
      </header>

      <div className="mt-6 space-y-8">
        {group(run.messages).map((g) => (
          <section key={g.key}>
            {g.items[0].agent !== 'system' && (
              <h2 className="mb-2 text-xs font-medium tracking-wider text-zinc-500 uppercase">
                {PHASE_LABEL[g.phase] ?? g.phase}
                {g.round > 0 && g.phase !== 'synthesize' ? ` · vòng ${g.round}` : ''}
              </h2>
            )}
            <div className={g.items.length > 1 ? 'grid gap-3 lg:grid-cols-2' : 'space-y-3'}>
              {g.items.map((m) => (
                <MessageCard key={m.id} message={m} />
              ))}
            </div>
          </section>
        ))}

        {run.error && (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 font-mono text-sm whitespace-pre-wrap text-red-300">{run.error}</p>
        )}

        {(run.final || run.diff) && (
          <section className="rounded-xl border border-zinc-700 bg-zinc-900/60">
            <div className="flex gap-1 border-b border-zinc-800 px-3 pt-3">
              {run.final && (
                <TabButton active={tab === 'final'} onClick={() => setTab('final')}>
                  {config.mode === 'debate' ? 'Giải pháp cuối' : 'Kết quả'}
                </TabButton>
              )}
              {config.mode === 'pair' && run.diff !== undefined && (
                <TabButton active={tab === 'diff' || !run.final} onClick={() => setTab('diff')}>
                  Diff
                </TabButton>
              )}
              {run.final && (
                <button
                  onClick={() => navigator.clipboard.writeText(tab === 'diff' ? (run.diff ?? '') : run.final!)}
                  className="ml-auto mb-2 rounded px-2 text-xs text-zinc-500 hover:text-zinc-200"
                >
                  Copy
                </button>
              )}
            </div>
            <div className="p-4 sm:p-5">
              {tab === 'diff' || !run.final ? <DiffView diff={run.diff ?? ''} /> : <Markdown>{run.final}</Markdown>}
            </div>
          </section>
        )}
        <div ref={bottom} />
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 pb-2 text-sm transition ${
        active ? 'border-zinc-200 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {children}
    </button>
  );
}
