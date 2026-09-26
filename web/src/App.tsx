import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type RunSummary } from './api.ts';
import Sidebar from './components/Sidebar.tsx';
import EmptyState from './EmptyState.tsx';
import Thread from './Thread.tsx';
import { useTheme } from './theme.ts';

const SIDEBAR_KEY = 'ai-duo:sidebar-hidden';
const isWide = () => window.matchMedia('(min-width: 768px)').matches;

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

export default function App() {
  const [runId, go] = useHashRoute();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  // Wide windows dock the sidebar and remember whether it is hidden; narrow ones slide it over.
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setHidden = useCallback((hidden: boolean) => {
    setSidebarHidden(hidden);
    try {
      localStorage.setItem(SIDEBAR_KEY, hidden ? '1' : '0');
    } catch {}
  }, []);
  const showSidebar = () => (isWide() ? setHidden(false) : setMenuOpen(true));
  const theme = useTheme();

  const refresh = useCallback(() => api.list().then(setRuns).catch(() => {}), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, runId]);

  const open = useCallback(
    (id: string | null) => {
      go(id);
      setMenuOpen(false);
    },
    [],
  );

  // Ctrl/Cmd+N starts a new session from anywhere; Ctrl/Cmd+B shows or hides the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'n') {
        e.preventDefault();
        open(null);
      } else if (key === 'b') {
        e.preventDefault();
        if (isWide()) setHidden(!sidebarHidden);
        else setMenuOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setHidden, sidebarHidden]);

  // Recent projects, most recently used first.
  const projects = useMemo(() => [...new Set(runs.map((r) => r.cwd).filter(Boolean))], [runs]);
  const onCreated = (id: string) => {
    open(id);
    void refresh();
  };
  const rename = async (id: string, title: string) => { await api.rename(id, title); await refresh(); };
  const remove = async (id: string) => { await api.delete(id); if (runId === id) open(null); await refresh(); };

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-fg">
      <Sidebar runs={runs} activeId={runId} onOpen={open} onRename={rename} onDelete={remove} theme={theme} open={menuOpen} onClose={() => setMenuOpen(false)} hidden={sidebarHidden} onHide={() => setHidden(true)} />
      <main className="min-w-0 flex-1">
        {runId ? (
          <Thread key={runId} id={runId} title={runs.find((r) => r.id === runId)?.title} projects={projects} onCreated={onCreated} onMenu={showSidebar} sidebarHidden={sidebarHidden} />
        ) : (
          <EmptyState projects={projects} onCreated={onCreated} onMenu={showSidebar} sidebarHidden={sidebarHidden} />
        )}
      </main>
    </div>
  );
}
