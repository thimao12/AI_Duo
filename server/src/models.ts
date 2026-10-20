import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ModelCatalog, ModelInfo } from './types.ts';

export type { ModelCatalog, ModelInfo } from './types.ts';

export const EFFORT = /^[a-z]{1,16}$/;

export const MODEL_ID = /^[\w.:/-]{1,64}$/;

/** Why `value` is not a usable model name (empty and null mean "CLI default"); `label` names the field. */
export function modelNameProblem(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return `${label} must be a valid model name`;
  const model = value.trim();
  if (model && (!MODEL_ID.test(model) || model.startsWith('-'))) {
    return `Invalid ${label}: use 1-64 letters, numbers, or . : / _ - and do not start with -`;
  }
  return undefined;
}

/** Why `value` is not a usable reasoning effort (empty, null and undefined mean "CLI default"). */
export function effortNameProblem(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !EFFORT.test(value)) return `Invalid ${label}: use a level like low, medium or high`;
  return undefined;
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Models that are never offered, routed to or accepted from a CLI's own list (Fable is not used). */
const EXCLUDED_MODELS: readonly RegExp[] = [/fable/i];

export const isExcludedModel = (id: string): boolean => EXCLUDED_MODELS.some((pattern) => pattern.test(id));

// Claude Code has no command that lists its models: the current versions are named here, in one place.
const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', description: 'Mạnh nhất, cho việc khó và dài.', efforts: CLAUDE_EFFORTS },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', description: 'Cân bằng tốc độ và chất lượng.', efforts: CLAUDE_EFFORTS },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', description: 'Nhanh và rẻ, cho việc nhỏ.', efforts: [] },
];

const claudeHome = (env: NodeJS.ProcessEnv) => env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');

/** "claude-sonnet-4-6" → "Sonnet 4.6"; anything else is shown as it is. */
function claudeName(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)(?:-.*)?$/.exec(id);
  return match ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}` : id;
}

/** Full Claude model ids named in Claude Code's own settings (`model`, `availableModels`), minus the ones in CLAUDE_MODELS. */
export function claudeLocalModels(env = process.env): ModelInfo[] {
  try {
    const settings = JSON.parse(readFileSync(path.join(claudeHome(env), 'settings.json'), 'utf8'));
    const named: unknown[] = [settings.model, ...(Array.isArray(settings.availableModels) ? settings.availableModels : [])];
    const known = new Set(CLAUDE_MODELS.map((m) => m.id));
    const ids = named.filter((id): id is string => typeof id === 'string' && /^claude-/.test(id) && MODEL_ID.test(id) && !isExcludedModel(id) && !known.has(id));
    return [...new Set(ids)].map((id) => ({ id, name: claudeName(id), efforts: CLAUDE_EFFORTS }));
  } catch {
    return [];
  }
}

const codexHome = (env: NodeJS.ProcessEnv) => env.CODEX_HOME || path.join(homedir(), '.codex');

const CODEX_DEFAULT_KEYS = new Map<string, 'model' | 'effort'>([['model', 'model'], ['model_reasoning_effort', 'effort']]);

/** The quoted string value of a `key = "value"` line, if it is one. */
function quotedValue(raw: string): string | undefined {
  const value = raw.trimStart();
  const end = value.indexOf('"', 1);
  return value.startsWith('"') && end >= 1 ? value.slice(1, end) : undefined;
}

/** Top-level `model` / `model_reasoning_effort` from Codex's config.toml (before any [section]). */
export function codexDefaults(env = process.env): { model?: string; effort?: string } {
  let text: string;
  try {
    text = readFileSync(path.join(codexHome(env), 'config.toml'), 'utf8');
  } catch {
    return {};
  }
  const defaults: { model?: string; effort?: string } = {};
  for (const raw of text.split('\n')) {
    const line = raw.trimStart();
    if (line.startsWith('[')) break;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = line.slice(0, equals).trimEnd();
    const name = CODEX_DEFAULT_KEYS.get(key);
    if (!name || defaults[name] !== undefined) continue;
    const value = quotedValue(line.slice(equals + 1));
    if (value !== undefined) defaults[name] = value;
  }
  return { model: defaults.model, effort: defaults.effort };
}

/** Models the local Codex CLI lists (its own cache of the server's model list). */
export function codexModels(env = process.env): ModelInfo[] {
  try {
    const cache = JSON.parse(readFileSync(path.join(codexHome(env), 'models_cache.json'), 'utf8'));
    if (!Array.isArray(cache.models)) return [];
    return cache.models
      .filter((m: any) => typeof m?.slug === 'string' && m.visibility !== 'hide' && !isExcludedModel(m.slug))
      .map((m: any) => ({
        id: m.slug,
        name: typeof m.display_name === 'string' ? m.display_name : m.slug,
        description: typeof m.description === 'string' ? m.description : undefined,
        efforts: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
          .map((l: any) => l?.effort)
          .filter((e: unknown): e is string => typeof e === 'string' && EFFORT.test(e)),
        defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined,
      }));
  } catch {
    return [];
  }
}

/** Models `agy models` listed last time it could be asked; the table below is the fallback. Gemini slugs carry their effort in the name, so no separate effort applies. */
const ANTIGRAVITY_MODELS: ModelInfo[] = [
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ['gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)'],
  ['gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)'],
  ['gemini-3.7-flash-low', 'Gemini 3.7 Flash (Low)'],
  ['gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)'],
  ['gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)'],
  ['gemini-3.6-flash-low', 'Gemini 3.6 Flash (Low)'],
  ['gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)'],
  ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)'],
  ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
].map(([id, name]) => ({ id, name, efforts: [] }));

/** The models `agy models` printed: one `id<TAB>name` per line after a progress line. */
export function parseAgyModels(output: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [id, name] = line.split('\t').map((part) => part.trim());
    if (id && name && MODEL_ID.test(id) && !isExcludedModel(id) && !models.some((m) => m.id === id)) models.push({ id, name, efforts: [] });
  }
  return models;
}

/** Runs `agy models`; rejects when the CLI cannot be started or answers nothing in time. */
async function runAgyModels(): Promise<string> {
  const [{ execFile }, { resolveBin }, { agentEnv }] = await Promise.all([import('node:child_process'), import('./agents/bins.ts'), import('./agents/billing.ts')]);
  const bin = resolveBin('antigravity');
  return new Promise((resolve, reject) => {
    execFile(bin.cmd, [...bin.prefixArgs, 'models'], { timeout: 20_000, windowsHide: true, shell: false, env: agentEnv(bin) }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

const REFRESH_MS = 10 * 60_000;
let live: { at: number; antigravity: ModelInfo[] } | undefined;
let pending: Promise<void> | undefined;

/** Forgets what `agy models` answered (tests). */
export const resetModelCache = () => {
  live = undefined;
  pending = undefined;
};

/** Asks the CLIs what they offer now (at most every ten minutes) and returns the catalog; a CLI that cannot answer keeps its last list. */
export async function refreshModels(env = process.env, run: () => Promise<string> = runAgyModels): Promise<ModelCatalog> {
  if (!live || Date.now() - live.at > REFRESH_MS) {
    pending ??= run().then(
      (out) => {
        const found = parseAgyModels(out);
        live = { at: Date.now(), antigravity: found.length ? found : (live?.antigravity ?? []) };
      },
      () => {
        live = { at: Date.now(), antigravity: live?.antigravity ?? [] };
      },
    ).finally(() => {
      pending = undefined;
    });
    await pending;
  }
  return listModels(env);
}

/** refreshModels for a run that is about to start: waits at most `ms` for the CLIs, then goes on with the last known lists. */
export async function warmModels(ms = 3000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  await Promise.race([refreshModels().then(() => undefined, () => undefined), late]);
  clearTimeout(timer);
}

export function listModels(env = process.env): ModelCatalog {
  return {
    claude: { models: [...CLAUDE_MODELS, ...claudeLocalModels(env)], default: {} },
    codex: { models: codexModels(env), default: codexDefaults(env) },
    antigravity: { models: live?.antigravity.length ? live.antigravity : ANTIGRAVITY_MODELS, default: {} },
  };
}
