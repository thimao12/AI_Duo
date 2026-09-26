import { useMemo, useState } from 'react';
import { ChevronRight, Monitor, Moon, Search, SquarePen, Sun, X } from 'lucide-react';
import type { RunSummary } from '../api.ts';
import type { ThemePref } from '../theme.ts';
import { basename, Kbd, Spinner, timeAgo, titleOf } from './ui.tsx';

const COLLAPSED_KEY = 'ai-duo:collapsed-projects';

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

const THEME: Record<ThemePref, { icon: typeof Sun; label: string }> = {
  system: { icon: Monitor, label: 'Theo hệ thống' },
  light: { icon: Sun, label: 'Sáng' },
  dark: { icon: Moon, label: 'Tối' },
};

function StatusMark({ status }: { status: RunSummary['status'] }) {
  if (status === 'running') return <Spinner className="size-3.5 text-info" />;
  const cls = status === 'error' ? 'bg-danger' : status === 'cancelled' ? 'bg-faint/60' : 'bg-transparent';
  return <span aria-hidden className={`mx-[3px] size-2 shrink-0 rounded-full ${cls}`} />;
}

interface SidebarProps {
  runs: RunSummary[];
  activeId: string | null;
  onOpen: (id: string | null) => void;
  theme: { pref: ThemePref; cycle: () => void };
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ runs, activeId, onOpen, theme, open, onClose }: SidebarProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, RunSummary[]>();
    for (const r of runs) {
      if (q && !r.prompt.toLowerCase().includes(q) && !basename(r.cwd).toLowerCase().includes(q)) continue;
      const key = r.cwd || '—';
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    // Projects ordered by their most recent run (runs arrive newest first).
    return [...map.entries()];
  }, [runs, query]);

  const toggle = (cwd: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });

  const ThemeIcon = THEME[theme.pref].icon;
  const row = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors';

  return (
    <>
      <aside
        aria-label="Danh sách phiên"
        className={`fixed inset-y-0 left-0 z-40 flex w-[264px] flex-col border-r border-line bg-sidebar transition-transform duration-200 ease-out md:static md:z-auto md:translate-x-0 ${
          open ? 'translate-x-0 shadow-pop' : '-translate-x-full'
        }`}
      >
        <div className="app-drag flex h-12 shrink-0 items-center gap-2 px-4">
          <span aria-hidden className="flex">
            <span className="size-3 rounded-full bg-claude" />
            <span className="-ml-1.5 size-3 rounded-full bg-codex/90" />
          </span>
          <span className="text-[14px] font-semibold tracking-tight">AI Duo</span>
          <button type="button" onClick={onClose} className="ml-auto grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 md:hidden">
            <X aria-hidden className="size-4" />
            <span className="sr-only">Đóng danh sách</span>
          </button>
        </div>

        <div className="space-y-0.5 px-2">
          <button type="button" onClick={() => onOpen(null)} className={`${row} h-8 font-medium text-fg hover:bg-surface-2 ${activeId === null ? 'bg-surface-2' : ''}`}>
            <SquarePen aria-hidden className="size-4 shrink-0 text-muted" />
            Phiên mới
            <span className="ml-auto hidden sm:inline">
              <Kbd>Ctrl N</Kbd>
            </span>
          </button>
          <label className={`${row} h-8 text-muted focus-within:bg-surface-2 hover:bg-surface-2`}>
            <Search aria-hidden className="size-4 shrink-0" />
            <span className="sr-only">Tìm phiên</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm"
              className="min-w-0 flex-1 bg-transparent text-fg placeholder:text-muted focus:outline-none"
            />
          </label>
        </div>

        <nav className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {runs.length === 0 && <p className="px-2.5 py-2 text-[12.5px] leading-relaxed text-faint">Chưa có phiên nào. Giao task đầu tiên ở khung bên phải.</p>}
          {runs.length > 0 && groups.length === 0 && <p className="px-2.5 py-2 text-[12.5px] text-faint">Không có phiên khớp “{query}”.</p>}
          {groups.map(([cwd, items]) => {
            const isCollapsed = collapsed.has(cwd) && !query;
            return (
              <section key={cwd} className="mb-2">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(cwd)}
                  title={cwd}
                  className="group flex h-7 w-full items-center gap-1.5 rounded-md px-2.5 text-left text-[12px] font-medium text-faint transition-colors hover:text-fg"
                >
                  <ChevronRight aria-hidden className={`size-3 shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
                  <span className="truncate">{basename(cwd)}</span>
                  <span className="ml-auto text-[11px] opacity-0 transition-opacity group-hover:opacity-100">{items.length}</span>
                </button>
                {!isCollapsed && (
                  <ul className="space-y-px">
                    {items.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => onOpen(r.id)}
                          aria-current={r.id === activeId ? 'page' : undefined}
                          title={r.prompt}
                          className={`${row} h-8 ${r.id === activeId ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg'}`}
                        >
                          <StatusMark status={r.status} />
                          <span className="min-w-0 flex-1 truncate">{titleOf(r.prompt)}</span>
                          {r.status === 'running' ? (
                            <span className="shrink-0 text-[11.5px] font-medium text-info">Đang chạy</span>
                          ) : (
                            <span className={`shrink-0 text-[11.5px] ${r.id === activeId ? 'text-muted' : 'text-faint'}`}>{timeAgo(r.createdAt)}</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </nav>

        <div className="shrink-0 border-t border-line px-2 py-2">
          <button type="button" onClick={theme.cycle} title="Đổi giao diện sáng/tối" className={`${row} h-8 text-muted hover:bg-surface-2 hover:text-fg`}>
            <ThemeIcon aria-hidden className="size-4 shrink-0" />
            Giao diện: {THEME[theme.pref].label}
          </button>
        </div>
      </aside>
      {open && <div aria-hidden className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={onClose} />}
    </>
  );
}
