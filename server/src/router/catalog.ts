import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { AGENT_NAMES } from '../agents/index.ts';
import type { AgentName } from '../agents/types.ts';
import { listModels } from '../models.ts';
import type { ModelChoice, Tier } from '../types.ts';
import { buildCatalog, overlayCatalog } from './tiers.ts';

export type Catalog = Record<AgentName, Record<Tier, Omit<ModelChoice, 'tier'>>>;

/**
 * Cheapest model that still does the job well, per tier: what applies when a CLI's own model list
 * cannot be read (see buildCatalog, which replaces these with the newest listed model of each tier).
 * Haiku gets no effort: effort only matters on the larger models.
 */
export const DEFAULT_CATALOG: Catalog = {
  claude: {
    light: { model: 'claude-haiku-5-5' },
    standard: { model: 'claude-sonnet-5-5', effort: 'medium' },
    heavy: { model: 'claude-opus-5-5', effort: 'high' },
  },
  codex: {
    light: { model: 'gpt-6-luna', effort: 'low' },
    standard: { model: 'gpt-6-sol', effort: 'medium' },
    heavy: { model: 'gpt-6-astra', effort: 'high' },
  },
  // Gemini slugs carry their effort in the name (see `agy models`).
  antigravity: {
    light: { model: 'gemini-3.8-flash-low' },
    standard: { model: 'gemini-3.8-flash-medium' },
    heavy: { model: 'gemini-3.1-pro-high' },
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
 * The catalog the router picks from: DEFAULT_CATALOG, overlaid with the newest model of each tier the CLIs
 * list, then with the JSON file at AI_DUO_ROUTER_CATALOG (same shape, any
 * subset of agents/tiers). Unsafe values are dropped, and a Codex model the local CLI doesn't
 * list falls back to the CLI default instead of failing the turn.
 */
function applyOverride(catalog: Catalog, file: string) {
  try {
    const override = JSON.parse(readFileSync(file, 'utf8'));
    for (const agent of AGENT_NAMES) {
      for (const tier of TIERS) {
        const o = override?.[agent]?.[tier];
        if (o && typeof o === 'object') catalog[agent][tier] = { model: o.model, effort: o.effort };
      }
    }
  } catch (err) {
    console.error(`Ignoring AI_DUO_ROUTER_CATALOG (${file}):`, (err as Error).message);
  }
}

/** Model ids a CLI lists, for the agents whose list is fixed or readable; claude takes aliases and full ids alike. */
function listedModels(agent: AgentName): Set<string> | undefined {
  if (agent !== 'antigravity') return undefined;
  const ids = listModels().antigravity.models.map((m) => m.id);
  return ids.length ? new Set(ids) : undefined;
}

function sanitizeCatalog(catalog: Catalog, codexModels: Set<string> | undefined) {
  for (const agent of AGENT_NAMES) {
    for (const tier of TIERS) {
      const c = catalog[agent][tier];
      if (typeof c.model !== 'string' || !SAFE.test(c.model)) c.model = undefined;
      if (typeof c.effort !== 'string' || !/^[a-z]{1,16}$/.test(c.effort)) c.effort = undefined;
      if (agent === 'codex' && c.model && codexModels && !codexModels.has(c.model)) c.model = undefined;
      // A model the CLI does not list falls back to the built-in choice for that tier, then to the CLI default.
      const listed = listedModels(agent);
      if (c.model && listed && !listed.has(c.model)) c.model = listed.has(DEFAULT_CATALOG[agent][tier].model ?? '') ? DEFAULT_CATALOG[agent][tier].model : undefined;
    }
  }
}

/** `codexModels`: the slugs Codex lists (read from its cache by default); null = there is no cache to check against. */
export function loadCatalog(env = process.env, codexModels: Set<string> | null | undefined = knownCodexModels()): Catalog {
  const catalog: Catalog = structuredClone(DEFAULT_CATALOG);
  overlayCatalog(catalog, buildCatalog(listModels({ ...process.env, ...env })));
  const file = env.AI_DUO_ROUTER_CATALOG;
  if (file && existsSync(file)) applyOverride(catalog, file);
  sanitizeCatalog(catalog, codexModels ?? undefined);
  return catalog;
}
