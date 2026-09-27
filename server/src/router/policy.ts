import { other, type AgentName } from '../agents/index.ts';
import type { Mode, ModelChoice, ModelRole, RoutePlan, TaskType, Tier } from '../types.ts';
import type { Catalog } from './catalog.ts';

export interface Decision {
  mode: Mode;
  coder: AgentName;
  reviewer: AgentName;
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
 * - Both Code and Plan use the same task-aware agent choice. Light work can use one agent for
 *   both roles; larger work uses the other agent one tier lower for review.
 */
export function decide(taskType: TaskType, complexity: Tier, catalog: Catalog, mode: Mode = 'code'): Decision {
  const pick = (agent: AgentName, tier: Tier): ModelChoice => ({ ...catalog[agent][tier], tier });
  const models: RoutePlan['models'] = {};
  const set = (agent: AgentName, role: ModelRole, tier: Tier) => ((models[agent] ??= {})[role] = pick(agent, tier));

  const coder: AgentName = taskType === 'refactor' || (complexity === 'heavy' && taskType !== 'bugfix') ? 'claude' : 'codex';
  const reviewer = complexity === 'light' ? coder : other(coder);
  if (mode === 'plan') {
    set(coder, 'thinker', complexity);
    set(reviewer, 'thinker', reviewer === coder ? complexity : down(complexity));
  } else {
    set(coder, 'coder', complexity);
    set(reviewer, 'reviewer', reviewer === coder ? complexity : down(complexity));
  }
  return { mode, coder, reviewer, judge: 'claude', maxRounds: 2, models };
}

const choice = (c?: ModelChoice) => (c ? [c.model ?? 'mặc định', c.effort].filter(Boolean).join('/') : 'mặc định');

/** One line for the run's "Định tuyến" note. */
export function describe(taskType: TaskType, complexity: Tier, d: Decision): string {
  const head = `Loại việc: ${TASK_LABEL[taskType]} · độ phức tạp: ${TIER_LABEL[complexity]}`;
  if (d.mode === 'code') {
    const reviewer = d.reviewer;
    return `${head} → Code: ${label(d.coder)} code (${choice(d.models[d.coder]?.coder)}), ${label(reviewer)} review (${choice(d.models[reviewer]?.reviewer)}), hỏi sau ${d.maxRounds} vòng chưa approve`;
  }
  return `${head} → Plan: ${label(d.coder)} lập kế hoạch (${choice(d.models[d.coder]?.thinker)}), ${label(d.reviewer)} review (${choice(d.models[d.reviewer]?.thinker)}), tối đa ${d.maxRounds} lượt`;
}
