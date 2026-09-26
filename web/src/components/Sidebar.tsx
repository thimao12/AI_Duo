import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, ExternalLink, Monitor, Moon, MoreHorizontal, Pencil, Search, SquarePen, Sun, Trash2, X } from 'lucide-react';
import { api, type AgentStatus, type RunSummary } from '../api.ts';
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
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  theme: { pref: ThemePref; cycle: () => void };
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ runs, activeId, onOpen, onRename, onDelete, theme, open, onClose }: SidebarProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentStatus | null>(null);
  const [showClaudeUsage, setShowClaudeUsage] = useState(false);
  const [showCodexStatus, setShowCodexStatus] = useState(false);
  const claudeLimits = runs.flatMap((run) => Object.entries(run.claudeLimits ?? {}).map(([type, limit]) => ({ type, ...limit, createdAt: run.createdAt }))).reduce<Record<string, { utilization: number; resetsAt?: number; createdAt: number }>>((latest, limit) => {
    const existing = latest[limit.type];
    if (!existing || limit.createdAt > existing.createdAt) latest[limit.type] = limit;
    return latest;
  }, {});

  useEffect(() => {
    let mounted = true;
    const refresh = () => api.agents().then((value) => { if (mounted) setAgents(value); }, () => { if (mounted) setAgents(null); });
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  const closeActions = () => { setMenuId(null); setEditingId(null); setConfirmId(null); setActionError(null); };
  const rename = async (id: string) => {
    if (!draftTitle.trim() || pending) return;
    setPending(true);
    try { await onRename(id, draftTitle.trim()); closeActions(); }
    catch (err) { setActionError((err as Error).message); }
    finally { setPending(false); }
  };
  const remove = async (id: string) => {
    if (pending) return;
    setPending(true);
    try { await onDelete(id); closeActions(); }
    catch (err) { setActionError((err as Error).message); }
    finally { setPending(false); }
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, RunSummary[]>();
    for (const r of runs) {
      if (q && !r.prompt.toLowerCase().includes(q) && !r.title?.toLowerCase().includes(q) && !basename(r.cwd).toLowerCase().includes(q)) continue;
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
              className="sidebar-search min-w-0 flex-1 bg-transparent text-fg placeholder:text-muted"
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
                      <li key={r.id} className="group/session">
                        <div className={`flex h-8 items-center rounded-lg ${r.id === activeId ? 'bg-surface-2' : 'hover:bg-surface-2'}`}>
                          <button
                            type="button"
                            onClick={() => { closeActions(); onOpen(r.id); }}
                            aria-current={r.id === activeId ? 'page' : undefined}
                            title={r.title || r.prompt}
                            className={`flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-lg pl-2.5 text-left text-[13px] ${r.id === activeId ? 'text-fg' : 'text-muted hover:text-fg'}`}
                          >
                            <StatusMark status={r.status} />
                            <span className="min-w-0 flex-1 truncate">{r.title || titleOf(r.prompt)}</span>
                            {r.status === 'running' ? (
                              <span className="shrink-0 text-[11.5px] font-medium text-info">Đang chạy</span>
                            ) : (
                              <span className={`hidden shrink-0 text-[11.5px] group-hover/session:hidden group-focus-within/session:hidden md:inline ${r.id === activeId ? 'text-muted' : 'text-faint'}`}>{timeAgo(r.createdAt)}</span>
                            )}
                          </button>
                          <button
                            type="button"
                            aria-label={`Tùy chọn phiên ${r.title || titleOf(r.prompt)}`}
                            aria-expanded={menuId === r.id}
                            onClick={() => { setMenuId(menuId === r.id ? null : r.id); setEditingId(null); setConfirmId(null); setActionError(null); }}
                            className={`mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface hover:text-fg focus-visible:opacity-100 ${menuId === r.id ? 'opacity-100' : 'opacity-100 md:opacity-0 md:group-hover/session:opacity-100 md:group-focus-within/session:opacity-100'}`}
                          >
                            <MoreHorizontal aria-hidden className="size-4" />
                          </button>
                        </div>
                        {menuId === r.id && <div className="mx-2 my-1 rounded-lg border border-line bg-bg p-1 shadow-pop">
                          {editingId === r.id ? <form onSubmit={(e) => { e.preventDefault(); void rename(r.id); }} className="flex gap-1 p-1">
                            <input autoFocus maxLength={120} aria-label="Tên phiên mới" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') closeActions(); }} className="min-w-0 flex-1 rounded border border-line bg-bg px-2 text-[12px] text-fg focus:border-line-strong focus:outline-none" />
                            <button type="submit" disabled={!draftTitle.trim() || pending} className="rounded bg-primary px-2 text-[11px] text-primary-fg disabled:opacity-50">Lưu</button>
                          </form> : confirmId === r.id ? <div className="p-1 text-[12px] text-fg">
                            <p className="px-1 pb-2">Xóa phiên này?</p>
                            <div className="flex gap-1"><button type="button" onClick={closeActions} className="rounded px-2 py-1 hover:bg-surface">Hủy</button><button type="button" disabled={pending} onClick={() => void remove(r.id)} className="rounded bg-danger px-2 py-1 text-white disabled:opacity-50">Xóa</button></div>
                          </div> : <>
                            <button type="button" onClick={() => { setEditingId(r.id); setDraftTitle(r.title || titleOf(r.prompt)); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-fg hover:bg-surface"><Pencil aria-hidden className="size-3.5" />Đổi tên</button>
                            <button type="button" onClick={() => setConfirmId(r.id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-danger hover:bg-surface"><Trash2 aria-hidden className="size-3.5" />Xóa</button>
                          </>}
                          {actionError && <p role="alert" className="px-2 py-1 text-[11px] text-danger">{actionError}</p>}
                        </div>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </nav>

        <div className="shrink-0 border-t border-line px-2 py-2">
          <div className="mb-2 space-y-0.5">
            <button type="button" aria-expanded={showClaudeUsage} onClick={() => setShowClaudeUsage((shown) => !shown)} className={`${row} h-9 text-muted hover:bg-surface-2 hover:text-fg`}>
              <span aria-hidden className="size-2 rounded-full bg-claude" />
              <span className="min-w-0 flex-1">Claude usage</span>
              <span className={`text-[11px] ${agents?.claude ? 'text-ok' : 'text-faint'}`}>{agents ? agents.claude ? 'CLI sẵn sàng' : 'CLI chưa sẵn sàng' : 'Đang kiểm tra'}</span>
              <ChevronRight aria-hidden className={`size-3 transition-transform ${showClaudeUsage ? 'rotate-90' : ''}`} />
            </button>
            {showClaudeUsage && (
              <div className="mx-2 rounded-lg border border-line bg-bg px-2.5 py-2 text-[11.5px] leading-relaxed text-muted">
                {Object.keys(claudeLimits).length ? Object.entries(claudeLimits).map(([type, limit]) => (
                  <div key={type} className="flex justify-between gap-2">
                    <span>{type === 'five_hour' ? '5 giờ' : type === 'seven_day' ? '7 ngày' : type}</span>
                    <span className="font-medium text-fg">{Math.round(limit.utilization * 100)}%{limit.resetsAt ? ` · reset ${new Date(limit.resetsAt * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
                  </div>
                )) : <p>Chưa có dữ liệu. Phần trăm sẽ hiện sau khi Claude gửi thông tin quota trong phiên làm việc.</p>}
              </div>
            )}
            <button type="button" aria-expanded={showCodexStatus} onClick={() => setShowCodexStatus((shown) => !shown)} className={`${row} h-9 text-muted hover:bg-surface-2 hover:text-fg`}>
              <span aria-hidden className="size-2 rounded-full bg-codex" />
              <span className="min-w-0 flex-1">Codex status</span>
              <span className={`text-[11px] ${agents?.codex ? 'text-ok' : 'text-faint'}`}>{agents ? agents.codex ? 'CLI sẵn sàng' : 'CLI chưa sẵn sàng' : 'Đang kiểm tra'}</span>
              <ChevronRight aria-hidden className={`size-3 transition-transform ${showCodexStatus ? 'rotate-90' : ''}`} />
            </button>
            {showCodexStatus && (
              <div className="mx-2 rounded-lg border border-line bg-bg px-2.5 py-2 text-[11.5px] leading-relaxed text-muted">
                <p>{agents?.codex ? `Codex CLI ${agents.codex}` : agents?.codexError || 'Chưa đọc được trạng thái Codex CLI.'}</p>
                <p className="mt-1">Để xem hạn mức tài khoản, nhập <code className="font-mono text-fg">/status</code> trong Codex.</p>
              </div>
            )}
          </div>
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
