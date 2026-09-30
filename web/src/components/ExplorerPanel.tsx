import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRight, File as FileIcon, Folder, X } from 'lucide-react';
import { api, type FileEntry } from '../api.ts';
import { Spinner } from './ui.tsx';

interface DirState {
  entries: FileEntry[];
  truncated: boolean;
}

interface Row {
  path: string;
  name: string;
  type: FileEntry['type'];
  depth: number;
}

interface Preview {
  path: string;
  size?: number;
  content?: string;
  truncated?: boolean;
  error?: string;
  loading: boolean;
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Does this entry, or (for a loaded dir) anything below it, match the filter? */
function matches(entry: FileEntry, dir: string, dirs: Record<string, DirState>, filter: string): boolean {
  if (entry.name.toLowerCase().includes(filter)) return true;
  if (entry.type !== 'dir') return false;
  const path = join(dir, entry.name);
  return (dirs[path]?.entries ?? []).some((child) => matches(child, path, dirs, filter));
}

/** Depth-first list of the rows currently visible. A filter reveals every loaded matching branch. */
function flatten(dir: string, depth: number, dirs: Record<string, DirState>, expanded: ReadonlySet<string>, filter: string): Row[] {
  const rows: Row[] = [];
  for (const entry of dirs[dir]?.entries ?? []) {
    if (filter && !matches(entry, dir, dirs, filter)) continue;
    const path = join(dir, entry.name);
    rows.push({ path, name: entry.name, type: entry.type, depth });
    const open = entry.type === 'dir' && (expanded.has(path) || (filter !== '' && path in dirs));
    if (open) rows.push(...flatten(path, depth + 1, dirs, expanded, filter));
  }
  return rows;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ---- Tree ------------------------------------------------------------------ */

function useTree(cwd: string) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const requested = useRef(new Set<string>());

  const load = useCallback((dir: string) => {
    if (requested.current.has(dir)) return;
    requested.current.add(dir);
    setLoading((prev) => new Set(prev).add(dir));
    api.files(cwd, dir).then(
      (value) => setDirs((prev) => ({ ...prev, [dir]: value })),
      (err: Error) => {
        requested.current.delete(dir);
        setErrors((prev) => ({ ...prev, [dir]: err.message }));
      },
    ).finally(() => setLoading((prev) => { const next = new Set(prev); next.delete(dir); return next; }));
  }, [cwd]);

  useEffect(() => { load(''); }, [load]);

  const setOpen = useCallback((path: string, open: boolean) => {
    if (open) load(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  }, [load]);

  const retry = useCallback((dir: string) => {
    setErrors((prev) => { const next = { ...prev }; delete next[dir]; return next; });
    load(dir);
  }, [load]);

  return { dirs, loading, errors, expanded, setOpen, retry };
}

interface TreeRowProps {
  row: Row;
  open: boolean;
  busy: boolean;
  selected: boolean;
  onToggle: (path: string, open: boolean) => void;
  onSelect: (path: string) => void;
}

function TreeRow({ row, open, busy, selected, onToggle, onSelect }: Readonly<TreeRowProps>) {
  const isDir = row.type === 'dir';
  const click = () => (isDir ? onToggle(row.path, !open) : onSelect(row.path));
  return (
    <li>
      <button
        type="button"
        data-tree-item
        data-path={row.path}
        aria-expanded={isDir ? open : undefined}
        aria-current={selected ? 'true' : undefined}
        title={row.path}
        onClick={click}
        onKeyDown={(e) => onTreeKeyDown(e, onToggle)}
        style={{ paddingLeft: 8 + row.depth * 14 }}
        className={`flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] transition-colors hover:bg-surface focus-visible:bg-surface focus-visible:outline-none ${selected ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg'}`}
      >
        {isDir ? <ChevronRight aria-hidden className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} /> : <span aria-hidden className="size-3 shrink-0" />}
        {isDir ? <Folder aria-hidden className="size-3.5 shrink-0" /> : <FileIcon aria-hidden className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{row.name}</span>
        {busy && <Spinner className="size-3" />}
      </button>
    </li>
  );
}

/** Arrow keys move between rows; right/left expand and collapse folders. */
function onTreeKeyDown(e: KeyboardEvent<HTMLButtonElement>, onToggle: TreeRowProps['onToggle']) {
  const items = [...(e.currentTarget.closest('ul')?.querySelectorAll<HTMLElement>('[data-tree-item]') ?? [])];
  const index = items.indexOf(e.currentTarget);
  if (index < 0) return;
  const current = items[index];
  const expanded = current.getAttribute('aria-expanded');
  const path = current.dataset.path ?? '';
  const moves: Record<string, () => void> = {
    ArrowDown: () => items[Math.min(items.length - 1, index + 1)]?.focus(),
    ArrowUp: () => items[Math.max(0, index - 1)]?.focus(),
    Home: () => items[0]?.focus(),
    End: () => items.at(-1)?.focus(),
    ArrowRight: () => { if (expanded === 'false') onToggle(path, true); },
    ArrowLeft: () => { if (expanded === 'true') onToggle(path, false); },
  };
  const move = moves[e.key];
  if (!move) return;
  e.preventDefault();
  move();
}

interface TreeProps {
  cwd: string;
  filter: string;
  selected: string | null;
  onSelect: (path: string) => void;
}

function FileTree({ cwd, filter, selected, onSelect }: Readonly<TreeProps>) {
  const { dirs, loading, errors, expanded, setOpen, retry } = useTree(cwd);
  const needle = filter.trim().toLowerCase();
  const rows = flatten('', 0, dirs, expanded, needle);
  const errorEntries = Object.entries(errors);
  const isOpen = (row: Row) => expanded.has(row.path) || (needle !== '' && row.path in dirs);

  if (loading.has('') && !dirs['']) return <p className="flex items-center gap-2 px-3 py-3 text-[12.5px] text-faint"><Spinner className="size-3" />Đang tải…</p>;
  return (
    <div>
      {errorEntries.map(([dir, message]) => (
        <p key={dir} role="alert" className="mx-2 my-1 flex items-start gap-2 rounded-md bg-danger/8 px-2 py-1.5 text-[12px] text-danger">
          <span className="min-w-0 flex-1 break-words">{dir ? `${dir}: ` : ''}{message}</span>
          <button type="button" onClick={() => retry(dir)} className="shrink-0 underline underline-offset-2">Thử lại</button>
        </p>
      ))}
      {rows.length === 0 && dirs[''] && <p className="px-3 py-3 text-[12.5px] text-faint">{needle ? 'Không có file khớp.' : 'Thư mục trống.'}</p>}
      <ul className="px-1.5 pb-2">
        {rows.map((row) => (
          <TreeRow key={row.path} row={row} open={isOpen(row)} busy={loading.has(row.path)} selected={selected === row.path} onToggle={setOpen} onSelect={onSelect} />
        ))}
      </ul>
      {dirs['']?.truncated && <p className="px-3 pb-2 text-[11.5px] text-faint">Danh sách quá dài, chỉ hiện một phần.</p>}
    </div>
  );
}

/* ---- Preview --------------------------------------------------------------- */

function PreviewBody({ preview }: Readonly<{ preview: Preview }>) {
  if (preview.loading) return <p className="flex items-center gap-2 px-3 py-3 text-[12.5px] text-faint"><Spinner className="size-3" />Đang mở…</p>;
  if (preview.error) return <p role="alert" className="px-3 py-3 text-[12.5px] text-danger">{preview.error}</p>;
  return (
    <>
      {preview.truncated && <p className="border-b border-line bg-warn/10 px-3 py-1 text-[11.5px] text-warn">File quá lớn, chỉ hiện phần đầu.</p>}
      <textarea readOnly wrap="off" value={preview.content ?? ''} aria-label={`Nội dung ${preview.path}`} className="min-h-0 flex-1 resize-none overflow-auto whitespace-pre border-0 bg-transparent px-3 py-2 font-mono text-[12px] leading-relaxed text-fg focus-visible:outline-none" />
    </>
  );
}

function PreviewPane({ preview, onClose }: Readonly<{ preview: Preview; onClose: () => void }>) {
  return (
    <section aria-label="Xem file" className="flex min-h-0 flex-1 flex-col border-t border-line">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted" title={preview.path}>{preview.path}</span>
        {preview.size !== undefined && <span className="shrink-0 text-[11px] text-faint">{formatSize(preview.size)}</span>}
        <button type="button" onClick={onClose} className="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface hover:text-fg">
          <X aria-hidden className="size-3.5" />
          <span className="sr-only">Đóng xem file</span>
        </button>
      </div>
      <PreviewBody preview={preview} />
    </section>
  );
}

function usePreview(cwd: string) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const token = useRef(0);
  const open = useCallback((path: string) => {
    const mine = ++token.current;
    setPreview({ path, loading: true });
    api.file(cwd, path).then(
      (value) => { if (token.current === mine) setPreview({ path, size: value.size, content: value.content, truncated: value.truncated, loading: false }); },
      (err: Error) => { if (token.current === mine) setPreview({ path, error: err.message, loading: false }); },
    );
  }, [cwd]);
  const close = useCallback(() => { token.current++; setPreview(null); }, []);
  return { preview, open, close };
}

/* ---- Panel ----------------------------------------------------------------- */

interface ExplorerPanelProps {
  cwd: string;
  onClose: () => void;
  /** Tab strip rendered under the header. */
  tabs?: ReactNode;
}

export default function ExplorerPanel({ cwd, onClose, tabs }: Readonly<ExplorerPanelProps>) {
  const [filter, setFilter] = useState('');
  const { preview, open, close } = usePreview(cwd);

  return (
    <aside aria-label="Explorer" className="flex h-full min-h-0 flex-col bg-bg">
      <header className="app-drag titlebar-inset flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="text-[13px] font-semibold">Explorer</h2>
        <button type="button" title="Đóng" onClick={onClose} className="ml-auto grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-fg">
          <X aria-hidden className="size-4" />
          <span className="sr-only">Đóng Explorer</span>
        </button>
      </header>
      {tabs}
      <div className="shrink-0 border-b border-line px-3 py-2">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Lọc file…"
          aria-label="Lọc file"
          className="h-8 w-full rounded-lg border border-line bg-bg px-2.5 text-[12.5px] text-fg placeholder:text-faint focus:border-line-strong focus:outline-none"
        />
      </div>
      <div className={`overflow-y-auto ${preview ? 'max-h-[45%] shrink-0' : 'min-h-0 flex-1'}`}>
        <FileTree key={cwd} cwd={cwd} filter={filter} selected={preview?.path ?? null} onSelect={open} />
      </div>
      {preview && <PreviewPane preview={preview} onClose={close} />}
    </aside>
  );
}
