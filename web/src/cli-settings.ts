import { useCallback, useEffect, useState } from 'react';
import { api, type AgentName, type CliConfig, type CliSettings } from './api.ts';

/** Text-field form of one CLI's settings. */
export interface CliDraft {
  binPath: string;
  /** One argument per line. */
  args: string;
  /** KEY=VALUE per line. */
  env: string;
  model: string;
  effort: string;
}

export interface SettingsDraft {
  claude: CliDraft;
  codex: CliDraft;
  timeout: string;
  testCommand: string;
}

export const EMPTY_CLI_DRAFT: CliDraft = { binPath: '', args: '', env: '', model: '', effort: '' };
export const EMPTY_DRAFT: SettingsDraft = { claude: EMPTY_CLI_DRAFT, codex: EMPTY_CLI_DRAFT, timeout: '', testCommand: '' };

const ENV_KEY = /^[A-Za-z_]\w*$/;

export function parseArgs(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseEnvLine(line: string, lineNo: number): { key: string; value: string } | string {
  const eq = line.indexOf('=');
  if (eq <= 0) return `Dòng ${lineNo}: cần dạng KEY=VALUE.`;
  const key = line.slice(0, eq).trim();
  if (!ENV_KEY.test(key)) return `Dòng ${lineNo}: tên biến "${key}" không hợp lệ (chỉ chữ, số, gạch dưới).`;
  return { key, value: line.slice(eq + 1) };
}

/** Blank lines and # comments are skipped. */
export function parseEnv(text: string): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parsed = parseEnvLine(line, i + 1);
    if (typeof parsed === 'string') errors.push(parsed);
    else env[parsed.key] = parsed.value;
  });
  return { env, errors };
}

function configFromDraft(d: CliDraft): { config: CliConfig; envErrors: string[] } {
  const { env, errors } = parseEnv(d.env);
  const args = parseArgs(d.args);
  const config: CliConfig = {};
  if (d.binPath.trim()) config.binPath = d.binPath.trim();
  if (args.length) config.extraArgs = args;
  if (Object.keys(env).length) config.env = env;
  if (d.model.trim()) config.defaultModel = d.model.trim();
  if (d.effort.trim()) config.defaultEffort = d.effort.trim();
  return { config, envErrors: errors };
}

function parseTimeout(text: string): { value?: number; error: string | null } {
  const t = text.trim();
  if (!t) return { error: null };
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1) return { error: 'Timeout phải là số nguyên dương (phút).' };
  return { value: n, error: null };
}

export interface DraftResult {
  cli: CliSettings;
  envErrors: Record<AgentName, string[]>;
  timeoutError: string | null;
  valid: boolean;
}

export function settingsFromDraft(draft: SettingsDraft): DraftResult {
  const claude = configFromDraft(draft.claude);
  const codex = configFromDraft(draft.codex);
  const timeout = parseTimeout(draft.timeout);
  const cli: CliSettings = { claude: claude.config, codex: codex.config };
  if (timeout.value !== undefined) cli.turnTimeoutMin = timeout.value;
  if (draft.testCommand.trim()) cli.testCommand = draft.testCommand.trim();
  const valid = !claude.envErrors.length && !codex.envErrors.length && !timeout.error;
  return { cli, envErrors: { claude: claude.envErrors, codex: codex.envErrors }, timeoutError: timeout.error, valid };
}

function draftFromConfig(c: CliConfig | undefined): CliDraft {
  return {
    binPath: c?.binPath ?? '',
    args: (c?.extraArgs ?? []).join('\n'),
    env: Object.entries(c?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    model: c?.defaultModel ?? '',
    effort: c?.defaultEffort ?? '',
  };
}

export function draftFromSettings(cli: CliSettings): SettingsDraft {
  return {
    claude: draftFromConfig(cli.claude),
    codex: draftFromConfig(cli.codex),
    timeout: cli.turnTimeoutMin === undefined ? '' : String(cli.turnTimeoutMin),
    testCommand: cli.testCommand ?? '',
  };
}

const canonical = (d: SettingsDraft) => JSON.stringify(settingsFromDraft(d).cli);

/** Loads the CLI settings while `open`, tracks edits against the saved copy and saves them. */
export function useCliSettings(open: boolean) {
  const [baseline, setBaseline] = useState<SettingsDraft>(EMPTY_DRAFT);
  const [draft, setDraft] = useState<SettingsDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  const adopt = useCallback((cli: CliSettings) => {
    const next = draftFromSettings(cli);
    setBaseline(next);
    setDraft(next);
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api.cliSettings().then((r) => adopt(r.cli), (err: Error) => setError(err.message));
  }, [open, adopt]);

  const result = settingsFromDraft(draft);
  const dirty = canonical(draft) !== canonical(baseline);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveCliSettings(result.cli);
      adopt(saved.cli);
      setRevision((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patchCli = (name: AgentName, patch: Partial<CliDraft>) => setDraft((d) => ({ ...d, [name]: { ...d[name], ...patch } }));
  const patchGlobal = (patch: Partial<Pick<SettingsDraft, 'timeout' | 'testCommand'>>) => setDraft((d) => ({ ...d, ...patch }));

  return { draft, baseline, result, dirty, error, busy, revision, save, patchCli, patchGlobal };
}
