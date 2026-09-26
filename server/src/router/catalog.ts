import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentName } from '../agents/types.ts';
import type { ModelChoice, Tier } from '../types.ts';

export type Catalog = Record<AgentName, Record<Tier, Omit<ModelChoice, 'tier'>>>;

/**
 * Cheapest model that still does the job well, per tier. Claude uses CLI aliases so it
 * keeps working as model versions move; Codex slugs come from `codex` 0.155's model list.
 * Haiku gets no effort: effort only matters on the larger models.
 */
export const DEFAULT_CATALOG: Catalog = {
  claude: {
    light: { model: 'haiku' },
    standard: { model: 'sonnet', effort: 'medium' },
    heavy: { model: 'opus', effort: 'high' },
  },
  codex: {
    light: { model: 'gpt-6-luna', effort: 'low' },
    standard: { model: 'gpt-6-sol', effort: 'medium' },
    heavy: { model: 'gpt-6-astra', effort: 'high' },
  },
};

const TIERS: Tier[] = ['light', 'standard', 'heavy'];
const SAFE = /^[\w.:-]{1,64}$/;

/** Codex slugs the local CLI knows about, or undefined when there is no cache to check against. */
function knownCodexModels(): Set<string> | undefined {
  const file = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'models_cache.json');
  try {
    const models = JSON.parse(readFileSync(file, 'utf8')).models;
    if (!Array.isArray(models)) return undefined;
    return new Set(models.map((m: any) => m?.slug).filter((s: unknown) => typeof s === 'string'));
  } catch {
    return undefined;
  }
}

/**
 * DEFAULT_CATALOG, overlaid with the JSON file at AI_DUO_ROUTER_CATALOG (same shape, any
 * subset of agents/tiers). Unsafe values are dropped, and a Codex model the local CLI doesn't
 * list falls back to the CLI default instead of failing the turn.
 */
export function loadCatalog(env = process.env, codexModels = knownCodexModels()): Catalog {
  const catalog: Catalog = structuredClone(DEFAULT_CATALOG);
  const file = env.AI_DUO_ROUTER_CATALOG;
  if (file && existsSync(file)) {
    try {
      const override = JSON.parse(readFileSync(file, 'utf8'));
      for (const agent of ['claude', 'codex'] as const) {
        for (const tier of TIERS) {
          const o = override?.[agent]?.[tier];
          if (o && typeof o === 'object') catalog[agent][tier] = { model: o.model, effort: o.effort };
        }
      }
    } catch (err) {
      console.error(`Ignoring AI_DUO_ROUTER_CATALOG (${file}):`, (err as Error).message);
    }
  }
  for (const agent of ['claude', 'codex'] as const) {
    for (const tier of TIERS) {
      const c = catalog[agent][tier];
      if (typeof c.model !== 'string' || !SAFE.test(c.model)) c.model = undefined;
      if (typeof c.effort !== 'string' || !/^[a-z]{1,16}$/.test(c.effort)) c.effort = undefined;
      if (agent === 'codex' && c.model && codexModels && !codexModels.has(c.model)) c.model = undefined;
    }
  }
  return catalog;
}
