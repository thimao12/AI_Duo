import type { PipelineDef, RoleDef } from '../../../server/src/types.ts';
import type { Selection } from './requestBuilder.ts';

/**
 * The one list of modes the composer cycles through (Tab / Shift+Tab): Code (two agents write and
 * review), Plan (plan, review, ask before editing), one mode per single-turn role, then the saved
 * pipelines. The roles named like a mode (code, plan) stay stored for pipelines but are not listed:
 * the modes cover them.
 */
export interface ModeEntry {
  /** `code`, `plan`, `role:<id>` or `pipeline:<id>`. */
  id: string;
  label: string;
  icon?: string;
  role?: RoleDef;
  pipeline?: PipelineDef;
}

/** Role ids that a built-in mode already stands for. */
const COVERED_BY_MODE: ReadonlySet<string> = new Set(['code', 'plan']);

export function modeList(roles: readonly RoleDef[], pipelines: readonly PipelineDef[]): ModeEntry[] {
  return [
    { id: 'code', label: 'Code' },
    { id: 'plan', label: 'Plan' },
    ...roles.filter((r) => !COVERED_BY_MODE.has(r.id)).map((role): ModeEntry => ({ id: `role:${role.id}`, label: role.name, icon: role.icon, role })),
    ...pipelines.map((pipeline): ModeEntry => ({ id: `pipeline:${pipeline.id}`, label: pipeline.name, icon: '⛓', pipeline })),
  ];
}

/** The entry the selection stands on. A hidden role (code, plan) counts as its mode. */
export function currentModeId(s: Pick<Selection, 'mode' | 'role' | 'pipelineId'>): string {
  if (s.pipelineId) return `pipeline:${s.pipelineId}`;
  if (s.mode === 'plan') return 'plan';
  if (s.role && !COVERED_BY_MODE.has(s.role.id)) return `role:${s.role.id}`;
  return 'code';
}

/** The entry `step` places away (wrapping); the first one when the current one is not in the list. */
export function stepMode(list: readonly ModeEntry[], currentId: string, step: 1 | -1): ModeEntry | undefined {
  if (list.length === 0) return undefined;
  const index = list.findIndex((m) => m.id === currentId);
  if (index < 0) return list[0];
  return list[(index + step + list.length) % list.length];
}
