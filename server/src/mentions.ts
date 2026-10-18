import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** `@path/to/file` in a prompt: the file's text is attached for the agent. Only files inside the project folder. */

const MAX_FILES = 5;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 160 * 1024;
const MENTION = /(^|[\s(])@((?:[\w.-]+[\/])*[\w.-]+)/g;

const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Text of the project file `name` names, or undefined when it is missing, outside `cwd`, large or binary. */
function readMentioned(cwd: string, name: string): { path: string; text: string } | undefined {
  try {
    const root = realpathSync.native(cwd);
    const file = realpathSync.native(path.resolve(root, name));
    if (!inside(root, file) || !statSync(file).isFile() || statSync(file).size > MAX_FILE_BYTES) return undefined;
    const text = readFileSync(file, 'utf8');
    if (text.includes('\0')) return undefined;
    return { path: path.relative(root, file).split(path.sep).join('/'), text };
  } catch {
    return undefined;
  }
}

/** The prompt with the contents of the mentioned files appended; unchanged when nothing resolves. */
export function expandMentions(prompt: string, cwd: string): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  let total = 0;
  for (const match of prompt.matchAll(MENTION)) {
    if (blocks.length >= MAX_FILES) break;
    const file = readMentioned(cwd, match[2]);
    if (!file || seen.has(file.path) || total + file.text.length > MAX_TOTAL_BYTES) continue;
    seen.add(file.path);
    total += file.text.length;
    blocks.push(`### ${file.path}\n\`\`\`\n${file.text.replace(/\s+$/, '')}\n\`\`\``);
  }
  return blocks.length ? `${prompt}\n\nFiles mentioned with @ (current contents):\n\n${blocks.join('\n\n')}` : prompt;
}

const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
const MAX_CONTEXT_BYTES = 32 * 1024;

/**
 * Project instructions an agent would not load by itself: Claude reads CLAUDE.md, Codex reads AGENTS.md,
 * so each gets the other's file when its own is missing. Antigravity gets whichever exists.
 */
export function projectContext(agent: 'claude' | 'codex' | 'antigravity', cwd: string): string {
  const own = agent === 'claude' ? 'CLAUDE.md' : agent === 'codex' ? 'AGENTS.md' : undefined;
  if (own && readMentioned(cwd, own)) return '';
  for (const name of CONTEXT_FILES) {
    if (name === own) continue;
    const file = readMentioned(cwd, name);
    if (file?.text.trim()) return `Project instructions (${file.path}):\n\n${file.text.slice(0, MAX_CONTEXT_BYTES).trim()}`;
  }
  return '';
}
