import { Check, Copy, X } from 'lucide-react';
import { useState } from 'react';
import DiffView, { type FileDiff } from './DiffView.tsx';

export default function ChangesPanel({ files, diff, onClose }: { files: FileDiff[]; diff: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  return (
    <aside aria-label="Thay đổi" className="flex h-full min-h-0 flex-col bg-bg">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
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
      <p className="border-b border-line px-3 py-1.5 text-[11.5px] text-faint">Chưa commit. Xem lại rồi tự commit trong repo.</p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DiffView files={files} />
      </div>
    </aside>
  );
}
