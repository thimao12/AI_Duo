import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

type Row = { id: number; type: 'hunk' | 'add' | 'del' | 'ctx' | 'meta'; text: string; old?: number; new?: number };

export interface FileDiff {
  name: string;
  status: 'modified' | 'added' | 'deleted';
  rows: Row[];
  added: number;
  removed: number;
}

const HEADER_LINE = /^(index |--- |\+\+\+ |similarity |rename |new file|deleted file|old mode|new mode)/;
const HUNK_LINE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Append a row of one diff line to its file, advancing the running old/new line numbers. */
function addRow(cur: FileDiff, line: string, no: { old: number; new: number }) {
  const push = (row: Omit<Row, 'id'>) => cur.rows.push({ ...row, id: cur.rows.length });
  const hunk = HUNK_LINE.exec(line);
  if (hunk) {
    no.old = Number(hunk[1]);
    no.new = Number(hunk[2]);
    push({ type: 'hunk', text: hunk[3].trim() || line });
  } else if (line.startsWith('+')) {
    cur.added++;
    push({ type: 'add', text: line.slice(1), new: no.new++ });
  } else if (line.startsWith('-')) {
    cur.removed++;
    push({ type: 'del', text: line.slice(1), old: no.old++ });
  } else if (line.startsWith('\\')) {
    push({ type: 'meta', text: line });
  } else if (line.startsWith(' ') || (line === '' && cur.rows.length)) {
    push({ type: 'ctx', text: line.slice(1), old: no.old++, new: no.new++ });
  } else if (line.startsWith('Binary')) {
    push({ type: 'meta', text: 'File nhị phân' });
  }
}

/** Split a unified `git diff` into files with numbered rows. */
export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  const no = { old: 0, new: 0 };
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line);
      cur = { name: m?.[1] ?? line, status: 'modified', rows: [], added: 0, removed: 0 };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file')) cur.status = 'added';
    else if (line.startsWith('deleted file')) cur.status = 'deleted';
    if (HEADER_LINE.test(line)) continue;
    addRow(cur, line, no);
  }
  // A trailing blank line of the diff output is not content.
  for (const f of files) while (f.rows.at(-1)?.type === 'ctx' && !f.rows.at(-1)?.text) f.rows.pop();
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

function DiffRow({ row: r }: Readonly<{ row: Row }>) {
  if (r.type === 'hunk' || r.type === 'meta') {
    return (
      <tr className={ROW[r.type]}>
        <td colSpan={4} className="px-3 py-0.5 whitespace-pre">
          {r.text}
        </td>
      </tr>
    );
  }
  return (
    <tr className={ROW[r.type]}>
      <td className="w-10 px-1.5 text-right align-top text-faint select-none">{r.old ?? ''}</td>
      <td className="w-10 px-1.5 text-right align-top text-faint select-none">{r.new ?? ''}</td>
      <td className="w-4 text-center align-top select-none">{MARK[r.type]}</td>
      <td className="pr-3 whitespace-pre">{r.text || ' '}</td>
    </tr>
  );
}

function FileBlock({ file, defaultOpen }: Readonly<{ file: FileDiff; defaultOpen: boolean }>) {
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
              {file.rows.map((r) => (
                <DiffRow key={r.id} row={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function DiffView({ files }: Readonly<{ files: FileDiff[] }>) {
  if (!files.length) return <p className="px-4 py-6 text-[13px] text-faint">Chưa có file nào thay đổi.</p>;
  return (
    <div>
      {files.map((f) => (
        <FileBlock key={f.name} file={f} defaultOpen={files.length <= 6} />
      ))}
    </div>
  );
}
