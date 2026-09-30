import { tmpdir } from 'node:os';
import { agentEnv, assertPlanOnly } from '../agents/billing.ts';
import { resolveBin } from '../agents/bins.ts';
import { claudeUsage } from '../agents/claude.ts';
import { spawnJsonl } from '../agents/process.ts';
import type { Usage } from '../agents/types.ts';
import { render } from '../prompts/index.ts';
import type { TaskType, Tier } from '../types.ts';
import { fencedBlocks } from '../../../shared/text.ts';

const TASK_TYPES = new Set<TaskType>(['edit', 'bugfix', 'refactor', 'design', 'explain']);
const TIERS = new Set<Tier>(['light', 'standard', 'heavy']);
/** Only the start of a long prompt is needed to tell what kind of task it is. */
const MAX_PROMPT_CHARS = 4000;

export interface ModelClassification {
  taskType: TaskType;
  complexity: Tier;
  usage?: Usage;
}

/** The last fenced JSON block, if it names a valid taskType and complexity. */
export function parseClassification(text: string): Omit<ModelClassification, 'usage'> | undefined {
  const raw = fencedBlocks(text, true).at(-1);
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    if (TASK_TYPES.has(v?.taskType) && TIERS.has(v?.complexity)) return { taskType: v.taskType, complexity: v.complexity };
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
    // Outside the plan the rules' answer is good enough; never pay for routing.
    await assertPlanOnly('claude', bin, tmpdir());
    await spawnJsonl(bin.cmd, [...bin.prefixArgs, ...HAIKU_ARGS], {
      cwd: tmpdir(),
      stdin: render('route', { prompt: clipped }),
      signal: signal ?? new AbortController().signal,
      timeoutMs: 60_000,
      env: agentEnv(bin),
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
