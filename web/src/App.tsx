import { useCallback, useEffect, useState } from 'react';
import { api, type RunSummary } from './api.ts';
import NewRun from './NewRun.tsx';
import RunView from './RunView.tsx';

function useHashRoute() {
  const read = () => window.location.hash.match(/^#\/run\/([\w-]+)/)?.[1] ?? null;
  const [runId, setRunId] = useState(read);
  useEffect(() => {
    const on = () => setRunId(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (id: string | null) => {
    window.location.hash = id ? `/run/${id}` : '/';
  };
  return [runId, go] as const;
}

const STATUS_DOT: Record<RunSummary['status'], string> = {
  running: 'bg-sky-400 animate-pulse',
  done: 'bg-emerald-400',
  error: 'bg-red-400',
  cancelled: 'bg-zinc-500',
};

function timeAgo(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ`;
  return new Date(t).toLocaleDateString();
}

export default function App() {
  const [runId, go] = useHashRoute();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);

  const refresh = useCallback(() => api.list().then(setRuns).catch(() => {}), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, runId]);

  const open = (id: string | null) => {
    go(id);
    setMenuOpen(false);
  };

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-zinc-800 bg-zinc-950 transition-transform md:static md:translate-x-0 ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="relative flex">
            <span className="size-3.5 rounded-full bg-claude" />
            <span className="-ml-1.5 size-3.5 rounded-full bg-codex/85" />
          </span>
          <span className="font-semibold tracking-tight text-zinc-100">AI Duo</span>
        </div>
        <div className="px-3">
          <button
            onClick={() => open(null)}
            className="w-full rounded-md border border-zinc-800 px-3 py-2 text-left text-sm text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900"
          >
            + Phiên mới
          </button>
        </div>
        <nav className="mt-4 flex-1 overflow-y-auto px-2 pb-4">
          <p className="px-2 pb-1 text-[11px] font-medium tracking-wider text-zinc-600 uppercase">Lịch sử</p>
          {runs.length === 0 && <p className="px-2 py-1 text-xs text-zinc-600">Chưa có phiên nào.</p>}
          {runs.map((r) => (
            <button
              key={r.id}
              onClick={() => open(r.id)}
              className={`block w-full rounded-md px-2 py-2 text-left transition hover:bg-zinc-900 ${r.id === runId ? 'bg-zinc-900' : ''}`}
            >
              <span className="flex items-center gap-2 text-[11px] text-zinc-500">
                <span className={`size-1.5 rounded-full ${STATUS_DOT[r.status]}`} />
                <span className="uppercase">{r.mode}</span>
                <span className="ml-auto">{timeAgo(r.createdAt)}</span>
              </span>
              <span className="mt-0.5 line-clamp-2 text-sm text-zinc-300">{r.prompt}</span>
            </button>
          ))}
        </nav>
      </aside>
      {menuOpen && <div className="fixed inset-0 z-20 bg-black/50 md:hidden" onClick={() => setMenuOpen(false)} />}

      <main className="min-w-0 flex-1 overflow-y-auto">
        <button onClick={() => setMenuOpen(true)} className="m-3 rounded-md border border-zinc-800 px-2.5 py-1 text-sm text-zinc-400 md:hidden">
          ☰ Menu
        </button>
        {runId ? <RunView key={runId} id={runId} /> : <NewRun onCreated={(id) => open(id)} />}
      </main>
    </div>
  );
}
