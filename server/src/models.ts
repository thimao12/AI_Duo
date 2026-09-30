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

// Claude Code takes stable aliases that follow the newest version of each family.
const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'opus', name: 'Opus', description: 'Mạnh nhất, cho việc khó và dài.', efforts: CLAUDE_EFFORTS },
  { id: 'sonnet', name: 'Sonnet', description: 'Cân bằng tốc độ và chất lượng.', efforts: CLAUDE_EFFORTS },
  { id: 'haiku', name: 'Haiku', description: 'Nhanh và rẻ, cho việc nhỏ.', efforts: [] },
];

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
      .filter((m: any) => typeof m?.slug === 'string' && m.visibility !== 'hide')
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

export function listModels(env = process.env): ModelCatalog {
  return {
    claude: { models: CLAUDE_MODELS, default: {} },
    codex: { models: codexModels(env), default: codexDefaults(env) },
  };
}
