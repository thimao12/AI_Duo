import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Monitor, Moon, MoreHorizontal, PanelLeftClose, Pencil, Search, SquarePen, Sun, Trash2, X } from 'lucide-react';
import { api, type AgentStatus, type RunSummary } from '../api.ts';
import type { ThemePref } from '../theme.ts';
import { basename, Kbd, Spinner, timeAgo, titleOf, useInputFocus } from './ui.tsx';

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

/** Every row leads with a 16px slot (icon, dot or chevron), so all sidebar labels start on one column. */
const slot = 'grid size-4 shrink-0 place-items-center';

function StatusMark({ status }: { status: RunSummary['status'] }) {
  if (status === 'running') return <span className={slot}><Spinner className="size-3.5 text-info" /></span>;
  const cls = status === 'error' ? 'bg-danger' : status === 'cancelled' ? 'bg-faint/60' : 'bg-transparent';
  return <span aria-hidden className={slot}><span className={`size-2 rounded-full ${cls}`} /></span>;
}

/**
 * Floating menu for one session, pinned to its ⋯ button. Fixed-positioned (and rendered outside the
 * aside, whose translate would otherwise trap it) so the scrolling list never clips or shifts it.
 */
function SessionMenu({ anchor, label, onDismiss, children }: { anchor: HTMLElement; label: string; onDismiss: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Open below the button, right edges aligned; flip above when the window runs out. Re-place when
  // the content changes size (menu → rename form → delete confirm).
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const margin = 8;
      const below = a.bottom + 4 + el.offsetHeight <= window.innerHeight - margin;
      setPos({
        top: below ? a.bottom + 4 : Math.max(margin, a.top - 4 - el.offsetHeight),
        left: Math.min(window.innerWidth - margin - el.offsetWidth, Math.max(margin, a.right - el.offsetWidth)),
      });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor]);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('button, input')?.focus();
  }, []);

  useEffect(() => {
    const outside = (t: EventTarget | null) => !panel.current?.contains(t as Node);
    const onDown = (e: PointerEvent) => {
      // The ⋯ button toggles on its own click.
      if (outside(e.target) && !anchor.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onDismiss();
      anchor.focus();
    };
    // A pinned menu would drift away from its row, so any scroll or resize closes it.
    const onScroll = (e: Event) => {
      if (outside(e.target)) onDismiss();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [anchor, onDismiss]);

  return (
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      style={pos ?? { top: 0, left: 0, visibility: 'hidden' }}
      className="fixed z-50 w-56 rounded-xl border border-line bg-bg p-1 shadow-pop"
    >
      {children}
    </div>
  );
}

const menuRow = 'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors hover:bg-surface focus-visible:bg-surface focus-visible:outline-none';

interface SidebarProps {
  runs: RunSummary[];
  activeId: string | null;
  onOpen: (id: string | null) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  theme: { pref: ThemePref; cycle: () => void };
  open: boolean;
  onClose: () => void;
  /** Docked (wide) sidebar hidden by the user. */
  hidden: boolean;
  onHide: () => void;
}

export default function Sidebar({ runs, activeId, onOpen, onRename, onDelete, theme, open, onClose, hidden, onHide }: SidebarProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const titleInput = useInputFocus<HTMLInputElement>();
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
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 60_000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  const closeActions = () => { setMenuId(null); setMenuAnchor(null); setEditingId(null); setConfirmId(null); setActionError(null); };
  const menuRun = menuId ? runs.find((r) => r.id === menuId) : undefined;
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
        } ${hidden ? 'md:hidden' : ''}`}
      >
        <div className="app-drag flex h-12 shrink-0 items-center gap-2.5 px-4.5">
          <span aria-hidden className="flex w-4">
            <span className="size-2.5 rounded-full bg-claude" />
            <span className="-ml-1 size-2.5 rounded-full bg-codex/90" />
          </span>
          <span className="text-[14px] font-semibold tracking-tight">AI Duo</span>
          <button type="button" onClick={onClose} className="-mr-1.5 ml-auto grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 md:hidden">
            <X aria-hidden className="size-4" />
            <span className="sr-only">Đóng danh sách</span>
          </button>
          <button type="button" onClick={onHide} title="Ẩn danh sách phiên (Ctrl B)" className="-mr-1.5 ml-auto hidden size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg md:grid">
            <PanelLeftClose aria-hidden className="size-4" />
            <span className="sr-only">Ẩn danh sách phiên</span>
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
                  className="group flex h-7 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[12px] font-medium text-faint transition-colors hover:text-fg"
                >
                  <span className={slot}>
                    <ChevronRight aria-hidden className={`size-3 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
                  </span>
                  <span className="truncate">{basename(cwd)}</span>
                  <span className="ml-auto text-[11px] opacity-0 transition-opacity group-hover:opacity-100">{items.length}</span>
                </button>
                {!isCollapsed && (
                  <ul className="space-y-px">
                    {items.map((r) => (
                      <li key={r.id} className="group/session">
                        <div className={`relative flex h-8 items-center rounded-lg ${r.id === activeId ? 'bg-surface-2' : 'hover:bg-surface-2'}`}>
                          <button
                            type="button"
                            onClick={() => { closeActions(); onOpen(r.id); }}
                            aria-current={r.id === activeId ? 'page' : undefined}
                            title={r.title || r.prompt}
                            className={`flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-lg pl-2.5 text-left text-[13px] ${menuId === r.id ? 'pr-9' : 'pr-9 md:pr-2.5 md:group-hover/session:pr-9 md:group-focus-within/session:pr-9'} ${r.id === activeId ? 'text-fg' : 'text-muted hover:text-fg'}`}
                          >
                            <StatusMark status={r.status} />
                            <span className="min-w-0 flex-1 truncate">{r.title || titleOf(r.prompt)}</span>
                            {r.status === 'running' ? (
                              <span className="shrink-0 text-[11.5px] font-medium text-info">Đang chạy</span>
                            ) : (
                              <span className={`hidden shrink-0 text-[11.5px] ${menuId === r.id ? '' : 'group-hover/session:hidden group-focus-within/session:hidden md:inline'} ${r.id === activeId ? 'text-muted' : 'text-faint'}`}>{timeAgo(r.createdAt)}</span>
                            )}
                          </button>
                          <button
                            type="button"
                            aria-label={`Tùy chọn phiên ${r.title || titleOf(r.prompt)}`}
                            aria-expanded={menuId === r.id}
                            aria-haspopup="menu"
                            onClick={(e) => {
                              if (menuId === r.id) return closeActions();
                              closeActions();
                              setMenuId(r.id);
                              setMenuAnchor(e.currentTarget);
                            }}
                            className={`absolute top-0.5 right-1 grid size-7 place-items-center rounded-md text-muted hover:bg-surface hover:text-fg focus-visible:opacity-100 ${menuId === r.id ? 'opacity-100' : 'opacity-100 md:opacity-0 md:group-hover/session:opacity-100 md:group-focus-within/session:opacity-100'}`}
                          >
                            <MoreHorizontal aria-hidden className="size-4" />
                          </button>
                        </div>
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
              <span aria-hidden className={slot}><span className="size-2 rounded-full bg-claude" /></span>
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
              <span aria-hidden className={slot}><span className="size-2 rounded-full bg-codex" /></span>
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
      {menuRun && menuAnchor && (
        <SessionMenu anchor={menuAnchor} label={`Tùy chọn phiên ${menuRun.title || titleOf(menuRun.prompt)}`} onDismiss={closeActions}>
          {editingId === menuRun.id ? (
            <form onSubmit={(e) => { e.preventDefault(); void rename(menuRun.id); }} className="p-1.5">
              <input
                ref={titleInput}
                maxLength={120}
                aria-label="Tên phiên mới"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                className="h-8 w-full rounded-lg border border-line bg-bg px-2.5 text-[13px] text-fg focus:border-line-strong focus:outline-none"
              />
              <div className="mt-2 flex justify-end gap-1">
                <button type="button" onClick={closeActions} className="h-7 rounded-lg px-2.5 text-[12.5px] text-muted hover:bg-surface hover:text-fg">Hủy</button>
                <button type="submit" disabled={!draftTitle.trim() || pending} className="h-7 rounded-lg bg-primary px-2.5 text-[12.5px] font-medium text-primary-fg disabled:opacity-50">Lưu</button>
              </div>
            </form>
          ) : confirmId === menuRun.id ? (
            <div className="p-1.5">
              <p className="px-1 text-[13px] text-fg">Xóa phiên này?</p>
              <p className="mt-0.5 px-1 text-[12px] leading-snug text-faint">Lịch sử và ảnh đính kèm sẽ bị xóa vĩnh viễn.</p>
              <div className="mt-2 flex justify-end gap-1">
                <button type="button" onClick={closeActions} className="h-7 rounded-lg px-2.5 text-[12.5px] text-muted hover:bg-surface hover:text-fg">Hủy</button>
                <button type="button" disabled={pending} onClick={() => void remove(menuRun.id)} className="h-7 rounded-lg bg-danger px-2.5 text-[12.5px] font-medium text-white disabled:opacity-50">Xóa</button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => { setEditingId(menuRun.id); setDraftTitle(menuRun.title || titleOf(menuRun.prompt)); }} className={`${menuRow} text-fg`}>
                <Pencil aria-hidden className="size-4 shrink-0 text-muted" />
                Đổi tên
              </button>
              <button type="button" role="menuitem" onClick={() => setConfirmId(menuRun.id)} className={`${menuRow} text-danger`}>
                <Trash2 aria-hidden className="size-4 shrink-0" />
                Xóa
              </button>
            </>
          )}
          {actionError && <p role="alert" className="px-2.5 py-1 text-[12px] text-danger">{actionError}</p>}
        </SessionMenu>
      )}
    </>
  );
}
