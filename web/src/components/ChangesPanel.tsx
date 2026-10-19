import { Check, Copy, GitCommitHorizontal, Undo2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import DiffView, { type FileDiff } from './DiffView.tsx';

/** What the panel needs to know about the run it shows. */
export interface ChangesRun {
  id: string;
  status: string;
  baseTree?: string;
  afterTree?: string;
  undoneAt?: number;
  commit?: string;
}

const field = 'h-8 w-full rounded-lg border border-line bg-bg px-2.5 text-[13px] text-fg outline-none focus:border-line-strong';

interface ChangesPanelProps {
  files: FileDiff[];
  diff: string;
  run?: ChangesRun;
  /** Called after an Undo or a Commit, so the run is read again. */
  onChanged?: () => void;
  onClose: () => void;
  tabs?: ReactNode;
}

export default function ChangesPanel({ files, diff, run, onChanged, onClose, tabs }: Readonly<ChangesPanelProps>) {
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // Undo and Commit need the Git trees the run recorded, and a run that is no longer writing.
  const canAct = !!run && run.status !== 'running' && !!run.baseTree && !!run.afterTree && !run.undoneAt && !run.commit && files.length > 0;
  const act = async (task: () => Promise<string>) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice({ ok: true, text: await task() });
      onChanged?.();
    } catch (err) {
      setNotice({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const undo = () => {
    if (!run || !window.confirm('Hoàn tác các thay đổi file của phiên này? Không có gì bị commit hay xoá khỏi lịch sử.')) return;
    void act(async () => {
      const done = await api.undoRun(run.id);
      return done.reverted ? `Đã hoàn tác ${done.files.length} file.` : 'Phiên này không đổi file nào.';
    });
  };
  const commit = () => {
    if (!run) return;
    void act(async () => {
      const done = await api.commitRun(run.id, message.trim() || undefined);
      setMessage('');
      return `Đã commit ${done.commit}: ${done.message} (${done.files.length} file). Chưa push.`;
    });
  };
  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  return (
    <aside aria-label="Thay đổi" className="flex h-full min-h-0 flex-col bg-bg">
      <header className="app-drag titlebar-inset flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="text-[13px] font-semibold">Thay đổi</h2>
        <span className="text-[12px] text-faint">{files.length} file</span>
        <span className="font-mono text-[11.5px] text-add-fg">+{added}</span>
        <span className="font-mono text-[11.5px] text-del-fg">−{removed}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            title="Copy diff"
            onClick={() => {
              void navigator.clipboard.writeText(diff).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            {copied ? <Check aria-hidden className="size-3.5 text-ok" /> : <Copy aria-hidden className="size-3.5" />}
            <span className="sr-only">Copy diff</span>
          </button>
          <button type="button" title="Đóng" onClick={onClose} className="grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-fg">
            <X aria-hidden className="size-4" />
            <span className="sr-only">Đóng panel thay đổi</span>
          </button>
        </div>
      </header>
      {tabs}
      <div className="space-y-2 border-b border-line px-3 py-2">
        <p className="text-[11.5px] text-faint">
          {run?.commit ? `Đã commit ${run.commit}.` : run?.undoneAt ? 'Đã hoàn tác các thay đổi của phiên này.' : 'Chưa commit. Xem lại, rồi hoàn tác hoặc commit riêng các file này.'}
        </p>
        {canAct && (
          <div className="flex items-center gap-1.5">
            <input className={field} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Nội dung commit (trống = tiêu đề phiên)" aria-label="Nội dung commit" disabled={busy} />
            <button type="button" onClick={commit} disabled={busy} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-fg px-2.5 text-[12.5px] font-medium text-bg disabled:opacity-50">
              <GitCommitHorizontal aria-hidden className="size-3.5" />
              Commit
            </button>
            <button type="button" onClick={undo} disabled={busy} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] text-muted hover:border-line-strong hover:text-fg disabled:opacity-50">
              <Undo2 aria-hidden className="size-3.5" />
              Hoàn tác
            </button>
          </div>
        )}
        {notice && (
          <p role={notice.ok ? 'status' : 'alert'} className={`text-[12px] ${notice.ok ? 'text-ok' : 'text-danger'}`}>
            {notice.text}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DiffView files={files} />
      </div>
    </aside>
  );
}
