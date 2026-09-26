import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ModelCatalog, ModelInfo } from './types.ts';

export type { ModelCatalog, ModelInfo } from './types.ts';

export const EFFORT = /^[a-z]{1,16}$/;

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Claude Code takes stable aliases that follow the newest version of each family.
const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'opus', name: 'Opus', description: 'Mạnh nhất, cho việc khó và dài.', efforts: CLAUDE_EFFORTS },
  { id: 'sonnet', name: 'Sonnet', description: 'Cân bằng tốc độ và chất lượng.', efforts: CLAUDE_EFFORTS },
  { id: 'haiku', name: 'Haiku', description: 'Nhanh và rẻ, cho việc nhỏ.', efforts: [] },
];

const codexHome = (env: NodeJS.ProcessEnv) => env.CODEX_HOME || path.join(homedir(), '.codex');

/** Top-level `model` / `model_reasoning_effort` from Codex's config.toml (before any [section]). */
export function codexDefaults(env = process.env): { model?: string; effort?: string } {
  let text: string;
  try {
    text = readFileSync(path.join(codexHome(env), 'config.toml'), 'utf8');
  } catch {
    return {};
  }
  const top = text.split(/^\s*\[/m)[0];
  const read = (key: string) => top.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
  return { model: read('model'), effort: read('model_reasoning_effort') };
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
