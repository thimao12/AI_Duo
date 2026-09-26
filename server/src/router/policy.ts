import { other, type AgentName } from '../agents/index.ts';
import type { Mode, ModelChoice, ModelRole, RoutePlan, TaskType, Tier } from '../types.ts';
import type { Catalog } from './catalog.ts';

export interface Decision {
  mode: Mode;
  coder: AgentName;
  judge: AgentName;
  maxRounds: number;
  models: RoutePlan['models'];
}

const down = (t: Tier): Tier => (t === 'heavy' ? 'standard' : 'light');
const label = (a: AgentName) => (a === 'claude' ? 'Claude' : 'Codex');

export const TASK_LABEL: Record<TaskType, string> = {
  edit: 'sửa/thêm code',
  bugfix: 'sửa lỗi',
  refactor: 'refactor',
  design: 'thiết kế/phân tích',
  explain: 'giải thích',
};
export const TIER_LABEL: Record<Tier, string> = { light: 'nhẹ', standard: 'vừa', heavy: 'nặng' };

/**
 * Token-first policy: the cheapest tier that fits the task, fewer rounds on small tasks, and
 * each role keeps one model for its whole session so the CLI's prompt cache stays warm.
 * - Changing code → pair. Codex codes well-scoped edits and bugs; Claude takes refactors and
 *   big cross-file changes. The reviewer is the other agent, one tier lower.
 * - Questions → debate. Explanations get a single critique round.
 */
export function decide(taskType: TaskType, complexity: Tier, catalog: Catalog): Decision {
  const pick = (agent: AgentName, tier: Tier): ModelChoice => ({ ...catalog[agent][tier], tier });
  const models: RoutePlan['models'] = {};
  const set = (agent: AgentName, role: ModelRole, tier: Tier) => ((models[agent] ??= {})[role] = pick(agent, tier));

  if (taskType === 'design' || taskType === 'explain') {
    const tier: Tier = taskType === 'explain' && complexity === 'heavy' ? 'standard' : complexity;
    const judge: AgentName = 'claude';
    set('claude', 'thinker', tier);
    set('codex', 'thinker', tier);
    set(judge, 'judge', tier === 'light' ? 'light' : 'standard');
    const maxRounds = taskType === 'explain' || complexity === 'light' ? 1 : 2;
    return { mode: 'debate', coder: 'codex', judge, maxRounds, models };
  }

  const coder: AgentName = taskType === 'refactor' || (complexity === 'heavy' && taskType !== 'bugfix') ? 'claude' : 'codex';
  set(coder, 'coder', complexity);
  set(other(coder), 'reviewer', down(complexity));
  const maxRounds = complexity === 'light' ? 2 : complexity === 'standard' ? 3 : 4;
  return { mode: 'pair', coder, judge: 'claude', maxRounds, models };
}

const choice = (c?: ModelChoice) => (c ? [c.model ?? 'mặc định', c.effort].filter(Boolean).join('/') : 'mặc định');

/** One line for the run's "Định tuyến" note. */
export function describe(taskType: TaskType, complexity: Tier, d: Decision): string {
  const head = `Loại việc: ${TASK_LABEL[taskType]} · độ phức tạp: ${TIER_LABEL[complexity]}`;
  if (d.mode === 'pair') {
    const reviewer = other(d.coder);
    return `${head} → Pair: ${label(d.coder)} code (${choice(d.models[d.coder]?.coder)}), ${label(reviewer)} review (${choice(d.models[reviewer]?.reviewer)}), tối đa ${d.maxRounds} vòng`;
  }
  return `${head} → Debate: Claude (${choice(d.models.claude?.thinker)}) và Codex (${choice(d.models.codex?.thinker)}), ${label(d.judge)} chốt (${choice(d.models[d.judge]?.judge)}), tối đa ${d.maxRounds} vòng`;
}
