/** Read complete triple-backtick blocks without repeatedly backtracking over long replies. */
export function fencedBlocks(text: string, jsonOnly = false): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf('```', cursor);
    if (start < 0) break;
    let content = start + 3;
    const json = text.slice(content, content + 4).toLowerCase() === 'json';
    if (jsonOnly && !json) {
      cursor = content;
      continue;
    }
    if (json) content += 4;
    const end = text.indexOf('```', content);
    if (end < 0) break;
    blocks.push(text.slice(content, end).trimStart());
    cursor = end + 3;
  }
  return blocks;
}

/** Verdict prefixes accept Markdown stars, with whitespace on either side of the stars. */
export function verdictBody(text: string): string {
  const body = text.trimStart();
  let start = 0;
  while (body[start] === '*') start++;
  return body.slice(start).trimStart();
}

export function lastVerdict(text: string, allowed: readonly string[], wordBoundary = false): string | undefined {
  const upper = text.toUpperCase();
  let cursor = 0;
  let last: string | undefined;
  for (;;) {
    const start = upper.indexOf('VERDICT:', cursor);
    if (start < 0) return last;
    cursor = start + 'VERDICT:'.length;
    const body = verdictBody(upper.slice(cursor));
    const match = allowed.find((value) => body.startsWith(value) && (!wordBoundary || !/\w/.test(body[value.length] ?? '')));
    if (match) last = match;
  }
}
