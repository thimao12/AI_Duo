import { AGENT_NAMES, agentLabel, defaultPartner, type AgentName } from '../agents/index.ts';
import type { Mode, ModelChoice, ModelRole, RoutePlan, TaskType, Tier } from '../types.ts';
import { isUsable, type Availability } from './availability.ts';
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
const label = agentLabel;

export const TASK_LABEL: Record<TaskType, string> = {
  edit: 'sửa/thêm code',
  bugfix: 'sửa lỗi',
  refactor: 'refactor',
  design: 'thiết kế/phân tích',
  explain: 'giải thích',
};
export const TIER_LABEL: Record<Tier, string> = { light: 'nhẹ', standard: 'vừa', heavy: 'nặng' };

/** Who does a kind of work best, in order; Antigravity follows the two it backs up. */
export function affinity(taskType: TaskType, complexity: Tier): AgentName[] {
  const claudeFirst = taskType === 'refactor' || (complexity === 'heavy' && taskType !== 'bugfix');
  const order: AgentName[] = claudeFirst ? ['claude', 'antigravity', 'codex'] : ['codex', 'claude', 'antigravity'];
  return [...order, ...AGENT_NAMES.filter((a) => !order.includes(a))];
}

export interface DecideOptions {
  /** Which CLIs may be used right now; an agent not listed is usable. */
  availability?: Availability;
  /** Images are attached: Antigravity cannot take them. */
  images?: boolean;
}

/**
 * Token-first policy: the cheapest tier that fits the task, fewer rounds on small tasks, and
 * each role keeps one model for its whole session so the CLI's prompt cache stays warm.
 * - The coder is the first usable agent in the task's affinity order. The reviewer is its usual
 *   partner (Claude and Codex review each other) when usable, else the next usable agent; light work
 *   can use one agent for both roles, larger work reviews one tier lower. When no CLI is usable the
 *   enabled agents' affinity order applies and preflight reports the problem.
 */
export function decide(taskType: TaskType, complexity: Tier, catalog: Catalog, mode: Mode = 'code', { availability, images }: DecideOptions = {}): Decision {
  const pick = (agent: AgentName, tier: Tier): ModelChoice => ({ ...catalog[agent][tier], tier });
  const models: RoutePlan['models'] = {};
  const set = (agent: AgentName, role: ModelRole, tier: Tier) => {
    models[agent] ??= {};
    models[agent][role] = pick(agent, tier);
  };

  const order = affinity(taskType, complexity).filter((agent) => availability?.[agent]?.enabled !== false && !(images && agent === 'antigravity'));
  if (!order.length) throw new Error('Không có AI đang bật phù hợp. Hãy bật ít nhất một AI trong cài đặt.');
  // Preflight reports failures of enabled agents; disabled ones are never fallback candidates.
  const usable = order.filter((agent) => isUsable(availability, agent));
  const candidates = usable.length ? usable : order;
  const coder: AgentName = candidates[0];
  const partner = defaultPartner(coder);
  const reviewer: AgentName = complexity === 'light' ? coder : candidates.includes(partner) && partner !== coder ? partner : (candidates.find((a) => a !== coder) ?? coder);
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
export function describe(taskType: TaskType, complexity: Tier, d: Decision, avoided: readonly string[] = []): string {
  const skipped = avoided.length ? ` (bỏ qua: ${avoided.join('; ')})` : '';
  const head = `Loại việc: ${TASK_LABEL[taskType]} · độ phức tạp: ${TIER_LABEL[complexity]}${skipped}`;
  if (d.mode === 'code') {
    const reviewer = d.reviewer;
    return `${head} → Code: ${label(d.coder)} code (${choice(d.models[d.coder]?.coder)}), ${label(reviewer)} review (${choice(d.models[reviewer]?.reviewer)}), hỏi sau ${d.maxRounds} vòng chưa approve`;
  }
  return `${head} → Plan: ${label(d.coder)} lập kế hoạch (${choice(d.models[d.coder]?.thinker)}), ${label(d.reviewer)} review (${choice(d.models[d.reviewer]?.thinker)}), tối đa ${d.maxRounds} lượt`;
}
