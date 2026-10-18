/** Unified diffs as rows for the terminal: parsing git output, and diffing two texts (an agent's Edit). */

export type DiffLineKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the old file (not on added lines) and the new file (not on removed lines). */
  oldNo?: number;
  newNo?: number;
  text: string;
}

export interface FileDiff {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  /** Binary files and mode-only changes have no lines to show. */
  note?: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The new path of a "diff --git a/x b/x" header (the old one for a deletion is fixed up later). */
function headerPath(header: string): string {
  const rest = header.slice('diff --git a/'.length);
  const split = rest.lastIndexOf(' b/');
  return split < 0 ? rest : rest.slice(split + 3);
}

/** Per-file rows of a unified diff (`git diff --no-color`). A `…` separator row marks a gap between hunks. */
export function parseDiff(diff: string | undefined): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let hunks = 0;
  for (const raw of (diff ?? '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git a/')) {
      file = { path: headerPath(line), added: 0, removed: 0, lines: [] };
      files.push(file);
      inHunk = false;
      hunks = 0;
      continue;
    }
    if (!file) continue;
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      if (hunks++ > 0) file.lines.push({ kind: 'ctx', text: '…' });
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('Binary files')) file.note = 'binary file';
      else if (line.startsWith('new file mode')) file.note ??= 'new file';
      else if (line.startsWith('deleted file mode')) file.note ??= 'deleted';
      else if (line.startsWith('rename to ')) file.note = `renamed to ${line.slice('rename to '.length)}`;
      continue;
    }
    if (line.startsWith('+')) {
      file.lines.push({ kind: 'add', newNo: newNo++, text: line.slice(1) });
      file.added++;
    } else if (line.startsWith('-')) {
      file.lines.push({ kind: 'del', oldNo: oldNo++, text: line.slice(1) });
      file.removed++;
    } else if (line.startsWith(' ')) {
      file.lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    }
    // "\ No newline at end of file" and anything else is skipped
  }
  return files;
}

const MAX_DIFF_LINES = 2000;

/**
 * Line diff of two texts (LCS), with up to `context` unchanged lines around each change.
 * Numbers count from the start of each text, so they are relative to the edited snippet.
 */
export function diffTexts(oldText: string, newText: string, context = 2): DiffLine[] {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [...a.map((text, i): DiffLine => ({ kind: 'del', oldNo: i + 1, text })), ...b.map((text, i): DiffLine => ({ kind: 'add', newNo: i + 1, text }))];
  }
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      all.push({ kind: 'ctx', oldNo: i + 1, newNo: j + 1, text: a[i] });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] > lcs[i + 1][j])) {
      all.push({ kind: 'add', newNo: j + 1, text: b[j++] });
    } else {
      // on a tie the removed line comes first, as in a unified diff
      all.push({ kind: 'del', oldNo: i + 1, text: a[i++] });
    }
  }
  // Keep changes and the context around them.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((line, index) => {
    if (line.kind === 'ctx') return;
    for (let k = Math.max(0, index - context); k <= Math.min(all.length - 1, index + context); k++) keep[k] = true;
  });
  const out: DiffLine[] = [];
  all.forEach((line, index) => {
    if (keep[index]) out.push(line);
    else if (out.at(-1)?.text !== '…' && out.length > 0) out.push({ kind: 'ctx', text: '…' });
  });
  while (out.at(-1)?.text === '…' && out.at(-1)?.kind === 'ctx' && out.at(-1)?.oldNo === undefined) out.pop();
  return out;
}

export function countChanges(lines: readonly DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.kind === 'add').length, removed: lines.filter((l) => l.kind === 'del').length };
}
