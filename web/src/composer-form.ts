import type { AgentName, NewRunRequest, Permission } from './api.ts';

export type ComposerForm = {
  mode: NewRunRequest['mode'];
  prompt: string;
  cwd: string;
  maxRounds: number;
  judge: AgentName;
  coder: AgentName;
  testCommand: string;
  turnTimeoutMin: number;
  models: Record<AgentName, string>;
  efforts: Record<AgentName, string>;
  /** Selected role ('' = none: the router decides as before). */
  roleId: string;
  /** Explicit agent ('' = router decides). */
  agent: AgentName | '';
  /** Explicit permission ('' = the role's own or the default). */
  permission: Permission | '';
  /** Pipeline to run when mode is 'pipeline'. */
  pipelineId: string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const text = (value: unknown) => typeof value === 'string' && !value.includes('\u0000') ? value : '';
const model = (value: unknown) => {
  const name = text(value).trim();
  return /^[\w.:/-]{1,64}$/.test(name) && !name.startsWith('-') ? name : '';
};
const id = (value: unknown) => typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value) ? value : '';
const effort = (value: unknown) => /^[a-z]{1,16}$/.test(text(value)) ? text(value) : '';

/** Rebuild only supported fields; stored data cannot add request options or arbitrary objects. */
export function normalizeForm(value: unknown): ComposerForm {
  const saved = record(value);
  const models = record(saved.models);
  const efforts = record(saved.efforts);
  return {
    mode: saved.mode === 'plan' || saved.mode === 'pipeline' ? saved.mode : 'code',
    prompt: text(saved.prompt),
    cwd: text(saved.cwd),
    maxRounds: 2,
    judge: 'claude',
    coder: 'codex',
    testCommand: text(saved.testCommand),
    turnTimeoutMin: typeof saved.turnTimeoutMin === 'number' && Number.isFinite(saved.turnTimeoutMin) && saved.turnTimeoutMin >= 1 && saved.turnTimeoutMin <= 180 ? saved.turnTimeoutMin : 30,
    models: { claude: model(models.claude), codex: model(models.codex) },
    efforts: { claude: effort(efforts.claude), codex: effort(efforts.codex) },
    roleId: id(saved.roleId),
    agent: saved.agent === 'claude' || saved.agent === 'codex' ? saved.agent : '',
    permission: saved.permission === 'read' || saved.permission === 'edit' ? saved.permission : '',
    pipelineId: id(saved.pipelineId),
  };
}

export function parseStoredForm(raw: string | null): ComposerForm {
  try {
    return { ...normalizeForm(JSON.parse(raw ?? '{}')), mode: 'code' };
  } catch {
    return normalizeForm(undefined);
  }
}

/** Fill agent, model, effort and permission from a role; choosing the selected role again clears them. */
export function toggleRole(form: ComposerForm, role: { id: string; agent: AgentName; model: string; effort: string; permission: Permission }): ComposerForm {
  if (form.roleId === role.id) return { ...form, roleId: '', agent: '', permission: '' };
  return {
    ...form,
    mode: 'code',
    roleId: role.id,
    agent: role.agent,
    permission: role.permission,
    models: { ...form.models, [role.agent]: role.model },
    efforts: { ...form.efforts, [role.agent]: role.effort },
  };
}

/**
 * The run request for a form. Nothing chosen = the router decides, as before; a chosen role, agent or
 * permission is sent explicitly (request fields beat the role, the role beats the router).
 */
export function buildRunRequest(form: ComposerForm): NewRunRequest {
  const { maxRounds: _rounds, judge: _judge, coder: _coder, agent, permission, roleId, pipelineId, ...rest } = normalizeForm(form);
  if (rest.mode === 'pipeline') return { ...rest, pipelineId };
  if (rest.mode === 'plan') return agent ? { ...rest, coder: agent } : rest;
  return {
    ...rest,
    ...(roleId ? { roleId } : {}),
    ...(agent ? { coder: agent } : {}),
    ...(permission ? { permission } : {}),
  };
}
