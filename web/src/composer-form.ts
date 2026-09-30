import type { AgentName, NewRunRequest } from './api.ts';

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
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const text = (value: unknown) => typeof value === 'string' && !value.includes('\u0000') ? value : '';
const model = (value: unknown) => {
  const name = text(value).trim();
  return /^[\w.:/-]{1,64}$/.test(name) && !name.startsWith('-') ? name : '';
};
const effort = (value: unknown) => /^[a-z]{1,16}$/.test(text(value)) ? text(value) : '';

/** Rebuild only supported fields; stored data cannot add request options or arbitrary objects. */
export function normalizeForm(value: unknown): ComposerForm {
  const saved = record(value);
  const models = record(saved.models);
  const efforts = record(saved.efforts);
  return {
    mode: saved.mode === 'plan' ? 'plan' : 'code',
    prompt: text(saved.prompt),
    cwd: text(saved.cwd),
    maxRounds: 2,
    judge: 'claude',
    coder: 'codex',
    testCommand: text(saved.testCommand),
    turnTimeoutMin: typeof saved.turnTimeoutMin === 'number' && Number.isFinite(saved.turnTimeoutMin) && saved.turnTimeoutMin >= 1 && saved.turnTimeoutMin <= 180 ? saved.turnTimeoutMin : 30,
    models: { claude: model(models.claude), codex: model(models.codex) },
    efforts: { claude: effort(efforts.claude), codex: effort(efforts.codex) },
  };
}

export function parseStoredForm(raw: string | null): ComposerForm {
  try {
    return { ...normalizeForm(JSON.parse(raw ?? '{}')), mode: 'code' };
  } catch {
    return normalizeForm(undefined);
  }
}
