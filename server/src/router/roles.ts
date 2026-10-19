import { agentLabel } from '../agents/index.ts';
import type { AgentName } from '../agents/types.ts';
import type { RoleDef, RoleRoute, TaskType, Tier } from '../types.ts';
import { isUsable, type Availability } from './availability.ts';
import type { Catalog } from './catalog.ts';
import { affinity } from './policy.ts';

/** The value of a role's model or effort that leaves the choice to the router. */
export const AUTO = 'auto';

export const isAuto = (value: string | undefined): boolean => value === AUTO;

const TIER_ORDER: Tier[] = ['light', 'standard', 'heavy'];
const rank = (tier: Tier) => TIER_ORDER.indexOf(tier);

/**
 * Cheapest tier that fits, kept inside what the role is for: graders (Review, Test) never go below
 * `standard`, a read-only answer (Ask, Plan) never above it; a role that edits follows the task.
 */
export function roleTier(role: Pick<RoleDef, 'gradable' | 'permission'>, complexity: Tier): Tier {
  if (role.gradable) return rank(complexity) < rank('standard') ? 'standard' : complexity;
  if (role.permission === 'read') return rank(complexity) > rank('standard') ? 'standard' : complexity;
  return complexity;
}

export interface RoleRouteOptions {
  taskType: TaskType;
  complexity: Tier;
  catalog: Catalog;
  availability?: Availability;
  /** Images are attached: Antigravity is out. */
  images?: boolean;
  /** An agent named in the request: it is used as given. */
  agent?: AgentName;
}

export interface ResolvedRole extends RoleRoute {
  /** One line for the route note, set when the router changed anything about the role. */
  note?: string;
}

/**
 * Agent, model and effort for one role in one run. The role's own agent stays when it is usable;
 * otherwise the best usable agent of the task takes over, and since a model name does not travel
 * between CLIs, the router picks that agent's model for the tier. A model or effort set to "auto"
 * is picked from the catalog by tier.
 */
export function resolveRole(role: RoleDef, o: RoleRouteOptions): ResolvedRole {
  const allowed = (agent: AgentName) => isUsable(o.availability, agent) && !(o.images && agent === 'antigravity');
  const order = affinity(o.taskType, o.complexity).filter((agent) => o.availability?.[agent]?.enabled !== false && !(o.images && agent === 'antigravity'));
  const fallback = order.includes(role.agent) ? role.agent : order[0];
  const agent = o.agent ?? (allowed(role.agent) ? role.agent : (order.find(allowed) ?? fallback));
  if (!agent) throw new Error('Không có AI đang bật phù hợp. Hãy bật ít nhất một AI trong cài đặt.');
  const moved = agent !== role.agent;
  const tier = roleTier(role, o.complexity);
  const picked = o.catalog[agent][tier];
  const autoModel = isAuto(role.model) || (moved && !o.agent);
  const model = autoModel ? picked.model : role.model || undefined;
  const effort = isAuto(role.effort) || (autoModel && !role.effort) ? picked.effort : role.effort || undefined;
  const route: ResolvedRole = { agent, ...(model && { model }), ...(effort && { effort }) };
  const changes: string[] = [];
  if (moved && !o.agent) changes.push(`${agentLabel(role.agent)} không dùng được → ${agentLabel(agent)}`);
  if (autoModel) changes.push(`model ${[model ?? 'mặc định', effort].filter(Boolean).join('/')} (mức ${tier})`);
  if (changes.length) route.note = `${role.name}: ${changes.join(', ')}`;
  return route;
}
