import type { AgentName } from '../../../server/src/agents/types.ts';
import type { RunRequest } from '../../../server/src/service.ts';
import type { RoleDef } from '../../../server/src/types.ts';
import type { SessionOverrides } from './panel-types.ts';

export type ChatMode = 'code' | 'plan';

/** What the composer has chosen for the next message. */
export interface Selection {
  mode: ChatMode;
  role: RoleDef | null;
  pipelineId: string | null;
  overrides: SessionOverrides;
  skipAuthCheck?: boolean;
}

/** The mode a request is sent with: a chosen pipeline wins over Code/Plan. */
export const effectiveMode = (s: Pick<Selection, 'mode' | 'pipelineId'>): 'code' | 'plan' | 'pipeline' => (s.pipelineId ? 'pipeline' : s.mode);

function modelFields(s: Selection, agent: AgentName | undefined): Pick<RunRequest, 'models' | 'efforts'> {
  const { model, effort } = s.overrides;
  const target = agent ?? s.overrides.agent;
  if (!target) return {};
  return {
    ...(model ? { models: { [target]: model } } : {}),
    ...(effort ? { efforts: { [target]: effort } } : {}),
  };
}

/**
 * The run request for the composer state, like the web's buildRunRequest: nothing chosen = the router
 * decides; a chosen role, agent or permission is sent explicitly (request fields beat the role, the
 * role beats the router). Plan and pipeline runs ignore the role.
 */
export function buildRequest(s: Selection, prompt: string, cwd: string): RunRequest {
  const base = { prompt, cwd, ...(s.skipAuthCheck ? { skipAuthCheck: true } : {}) };
  const { agent, permission } = s.overrides;
  if (s.pipelineId) return { ...base, mode: 'pipeline', pipelineId: s.pipelineId };
  if (s.mode === 'plan') return { ...base, mode: 'plan', ...(agent ? { coder: agent } : {}), ...modelFields(s, agent) };
  return {
    ...base,
    mode: 'code',
    ...(s.role ? { roleId: s.role.id } : {}),
    ...(agent ? { coder: agent } : {}),
    ...(permission ? { permission } : {}),
    ...modelFields(s, agent ?? s.role?.agent),
  };
}
