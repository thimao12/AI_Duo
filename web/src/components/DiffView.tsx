import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

type Row = { type: 'hunk' | 'add' | 'del' | 'ctx' | 'meta'; text: string; old?: number; new?: number };

export interface FileDiff {
  name: string;
  status: 'modified' | 'added' | 'deleted';
  rows: Row[];
  added: number;
  removed: number;
}

/** Split a unified `git diff` into files with numbered rows. */
export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/);
      cur = { name: m?.[1] ?? line, status: 'modified', rows: [], added: 0, removed: 0 };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file')) cur.status = 'added';
    else if (line.startsWith('deleted file')) cur.status = 'deleted';
    if (/^(index |--- |\+\+\+ |similarity |rename |new file|deleted file|old mode|new mode)/.test(line)) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      cur.rows.push({ type: 'hunk', text: hunk[3].trim() || line });
    } else if (line.startsWith('+')) {
      cur.added++;
      cur.rows.push({ type: 'add', text: line.slice(1), new: newNo++ });
    } else if (line.startsWith('-')) {
      cur.removed++;
      cur.rows.push({ type: 'del', text: line.slice(1), old: oldNo++ });
    } else if (line.startsWith('\\')) {
      cur.rows.push({ type: 'meta', text: line });
    } else if (line.startsWith(' ') || (line === '' && cur.rows.length)) {
      cur.rows.push({ type: 'ctx', text: line.slice(1), old: oldNo++, new: newNo++ });
    } else if (line.startsWith('Binary')) {
      cur.rows.push({ type: 'meta', text: 'File nhị phân' });
    }
  }
  // A trailing blank line of the diff output is not content.
  for (const f of files) while (f.rows.length && f.rows[f.rows.length - 1].type === 'ctx' && !f.rows[f.rows.length - 1].text) f.rows.pop();
  return files;
}

const ROW: Record<Row['type'], string> = {
  add: 'bg-add-bg text-add-fg',
  del: 'bg-del-bg text-del-fg',
  ctx: 'text-muted',
  hunk: 'bg-surface text-faint',
  meta: 'text-faint italic',
};

const MARK: Record<Row['type'], string> = { add: '+', del: '−', ctx: ' ', hunk: '', meta: '' };

function FileBlock({ file, defaultOpen }: { file: FileDiff; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const slash = file.name.lastIndexOf('/');
  const dir = slash >= 0 ? file.name.slice(0, slash + 1) : '';
  const base = file.name.slice(slash + 1);
  return (
    <section className="border-b border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="sticky top-0 z-10 flex w-full items-center gap-2 bg-bg px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-surface"
      >
        <ChevronRight aria-hidden className={`size-3.5 shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
          <span className="text-faint">{dir}</span>
          <span className="text-fg">{base}</span>
        </span>
        {file.status !== 'modified' && <span className="shrink-0 text-[11px] text-faint">{file.status === 'added' ? 'mới' : 'đã xoá'}</span>}
        <span className="shrink-0 font-mono text-[11.5px] text-add-fg">+{file.added}</span>
        <span className="shrink-0 font-mono text-[11.5px] text-del-fg">−{file.removed}</span>
      </button>
      {open && (
        <div className="overflow-x-auto pb-1">
          <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.6]">
            <tbody>
              {file.rows.map((r, i) =>
                r.type === 'hunk' || r.type === 'meta' ? (
                  <tr key={i} className={ROW[r.type]}>
                    <td colSpan={4} className="px-3 py-0.5 whitespace-pre">
                      {r.text}
                    </td>
                  </tr>
                ) : (
                  <tr key={i} className={ROW[r.type]}>
                    <td className="w-10 px-1.5 text-right align-top text-faint/70 select-none">{r.old ?? ''}</td>
                    <td className="w-10 px-1.5 text-right align-top text-faint/70 select-none">{r.new ?? ''}</td>
                    <td className="w-4 text-center align-top select-none">{MARK[r.type]}</td>
                    <td className="pr-3 whitespace-pre">{r.text || ' '}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function DiffView({ files }: { files: FileDiff[] }) {
  if (!files.length) return <p className="px-4 py-6 text-[13px] text-faint">Chưa có file nào thay đổi.</p>;
  return (
    <div>
      {files.map((f) => (
        <FileBlock key={f.name} file={f} defaultOpen={files.length <= 6} />
      ))}
    </div>
  );
}
