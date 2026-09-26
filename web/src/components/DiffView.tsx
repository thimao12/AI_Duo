interface FileDiff {
  name: string;
  lines: string[];
  added: number;
  removed: number;
}

function parse(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/);
      cur = { name: m?.[1] ?? line, lines: [], added: 0, removed: 0 };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^(index |--- |\+\+\+ |similarity |rename |new file|deleted file)/.test(line)) continue;
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
    cur.lines.push(line);
  }
  return files;
}

function lineClass(l: string) {
  if (l.startsWith('@@')) return 'text-sky-400/80 bg-sky-500/5';
  if (l.startsWith('+')) return 'text-emerald-300 bg-emerald-500/10';
  if (l.startsWith('-')) return 'text-red-300 bg-red-500/10';
  return 'text-zinc-400';
}

export default function DiffView({ diff }: { diff: string }) {
  const files = parse(diff);
  if (!files.length) return <p className="text-sm text-zinc-500">No file changes.</p>;
  return (
    <div className="space-y-2">
      {files.map((f) => (
        <details key={f.name} open={files.length <= 4} className="overflow-hidden rounded-md border border-zinc-800">
          <summary className="flex cursor-pointer items-center gap-3 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-300">
            <span className="truncate">{f.name}</span>
            <span className="ml-auto shrink-0 text-emerald-400">+{f.added}</span>
            <span className="shrink-0 text-red-400">−{f.removed}</span>
          </summary>
          <pre className="max-h-[32rem] overflow-auto font-mono text-[12px] leading-5">
            {f.lines.map((l, i) => (
              <div key={i} className={`px-3 whitespace-pre ${lineClass(l)}`}>
                {l || ' '}
              </div>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
}
