import { agentLabel } from '../agents/index.ts';
import type { AgentCheck, AgentName } from '../agents/types.ts';
import type { AgentUsage } from '../types.ts';

/** A window used this much (or more) counts as exhausted: the router moves the work to another CLI. */
export const QUOTA_LIMIT_PERCENT = 90;

export interface AgentAvailability {
  usable: boolean;
  /** Explicitly disabled agents must also be excluded from the preflight fallback. */
  enabled?: boolean;
  /** Why the CLI is avoided (Vietnamese, shown in the route note). */
  reason?: string;
}

/** Agents missing from the map count as usable, so a router without checks behaves as before. */
export type Availability = Partial<Record<AgentName, AgentAvailability>>;

export const isUsable = (availability: Availability | undefined, agent: AgentName): boolean => availability?.[agent]?.usable !== false;

/** The most used non-stale window of an agent, or undefined when it reports none. */
function worstWindow(usage: AgentUsage | undefined): { percent: number; label: string } | undefined {
  const windows = [
    { window: usage?.fiveHour, label: '5 giờ' },
    { window: usage?.weekly, label: 'tuần' },
  ].filter((w) => w.window && !w.window.stale);
  const worst = windows.sort((a, b) => b.window!.usedPercent - a.window!.usedPercent)[0];
  return worst ? { percent: Math.round(worst.window!.usedPercent), label: worst.label } : undefined;
}

/**
 * Whether the router may send work to `agent`: it must be installed and, unless its login cannot be
 * read at all (unknown), logged in, and no quota window may be nearly used up.
 */
export function evaluateAvailability(agent: AgentName, check: AgentCheck | undefined, usage: AgentUsage | undefined, enabled = true): AgentAvailability {
  const name = agentLabel(agent);
  if (!enabled) return { usable: false, enabled: false, reason: `${name} đã tắt trong cài đặt` };
  if (check?.error) return { usable: false, reason: `${name} chưa cài hoặc không chạy được` };
  if (check?.auth === 'failed') return { usable: false, reason: `${name} chưa đăng nhập` };
  const worst = worstWindow(usage);
  if (worst && worst.percent >= QUOTA_LIMIT_PERCENT) return { usable: false, reason: `${name} đã dùng ${worst.percent}% hạn mức ${worst.label}` };
  return { usable: true };
}

/** The reasons of the unusable agents, for the route note. */
export const avoidedReasons = (availability: Availability | undefined): string[] =>
  Object.values(availability ?? {}).flatMap((a) => (a && !a.usable && a.reason ? [a.reason] : []));
