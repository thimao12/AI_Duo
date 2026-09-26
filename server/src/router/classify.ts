import { tmpdir } from 'node:os';
import { resolveBin } from '../agents/bins.ts';
import { claudeUsage } from '../agents/claude.ts';
import { spawnJsonl } from '../agents/process.ts';
import type { Usage } from '../agents/types.ts';
import { render } from '../prompts/index.ts';
import type { TaskType, Tier } from '../types.ts';

const TASK_TYPES: TaskType[] = ['edit', 'bugfix', 'refactor', 'design', 'explain'];
const TIERS: Tier[] = ['light', 'standard', 'heavy'];
/** Only the start of a long prompt is needed to tell what kind of task it is. */
const MAX_PROMPT_CHARS = 4000;

export interface ModelClassification {
  taskType: TaskType;
  complexity: Tier;
  usage?: Usage;
}

/** The last fenced JSON block, if it names a valid taskType and complexity. */
export function parseClassification(text: string): Omit<ModelClassification, 'usage'> | undefined {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = blocks.at(-1)?.[1];
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    if (TASK_TYPES.includes(v?.taskType) && TIERS.includes(v?.complexity)) return { taskType: v.taskType, complexity: v.complexity };
  } catch {}
  return undefined;
}

export type Classifier = (prompt: string, signal?: AbortSignal) => Promise<ModelClassification | undefined>;

/**
 * Bare `claude -p` flags: no tools, a one-line system prompt, no settings, MCP servers,
 * skills or saved session. A plain agent call spends ~26k input tokens on Claude Code's own
 * system prompt and tool definitions; this one spends a few hundred.
 */
export const HAIKU_ARGS = [
  '-p', '--model', 'haiku', '--output-format', 'json',
  '--tools', '', '--system-prompt', 'You classify software tasks. Reply only with the requested JSON block.',
  '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
];

/**
 * One short Haiku call for prompts the keyword rules can't place. Runs in the temp dir so it
 * never sees the repo. Any failure returns undefined and the caller keeps the rules' answer.
 */
export const classifyWithHaiku: Classifier = async (prompt, signal) => {
  const clipped = prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}\n…(truncated)` : prompt;
  let result: any;
  try {
    const bin = resolveBin('claude');
    await spawnJsonl(bin.cmd, [...bin.prefixArgs, ...HAIKU_ARGS], {
      cwd: tmpdir(),
      stdin: render('route', { prompt: clipped }),
      signal: signal ?? new AbortController().signal,
      timeoutMs: 60_000,
      env: bin.env ? { ...process.env, ...bin.env } : undefined,
      onJson: (ev) => {
        if (ev?.type === 'result') result = ev;
      },
      onRawLine: () => {},
    });
    if (!result || result.is_error || typeof result.result !== 'string') throw new Error(`no usable result: ${JSON.stringify(result)?.slice(0, 300)}`);
    const parsed = parseClassification(result.result);
    if (!parsed) throw new Error(`unparseable reply: ${result.result.slice(0, 300)}`);
    return { ...parsed, usage: claudeUsage(result) };
  } catch (err) {
    console.error('Router: Haiku classification failed, using rules:', (err as Error).message);
    return undefined;
  }
};
