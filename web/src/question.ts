/** Detect a choice question at the end of an agent reply. Ordinary numbered lists stay as Markdown. */
export function parseChoiceQuestion(text: string): { question: string; options: string[] } | null {
  const lines = text.trim().split(/\r?\n/);
  const options: string[] = [];
  let index = lines.length - 1;
  while (index >= 0 && options.length < 3) {
    const line = lines[index].trim().replace(/^\*\*([1-3][.)])\*\*/, '$1');
    const match = /^([1-3])[.)]\s/.exec(line);
    const content = match ? line.slice(2).trim() : '';
    if (!match || !content || Number(match[1]) !== 3 - options.length) break;
    options.unshift(content.replaceAll('**', ''));
    index--;
  }
  if (options.length !== 3 || !options.every(Boolean)) return null;
  // The three choices must not be the tail of a longer numbered list.
  if (index >= 0 && /^(\*\*)?\d+[.)](\*\*)?\s+/.test(lines[index].trim())) return null;
  const question = lines.slice(Math.max(0, index - 3), index + 1).reverse().map((line) => line.trim().replace(/^#{1,6}\s*/, '').replaceAll('**', '')).find((line) => /[?？]\s*$/.test(line));
  return question ? { question, options } : null;
}
