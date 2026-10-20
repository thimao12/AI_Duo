import { AGENT_NAMES, type AgentName } from '../agents/index.ts';
import type { ModelCatalog, ModelInfo, ModelChoice, Tier } from '../types.ts';
import type { Catalog } from './catalog.ts';

const TIERS: Tier[] = ['light', 'standard', 'heavy'];

/** Effort each tier asks for when the model accepts it. */
const TIER_EFFORT: Record<Tier, string> = { light: 'low', standard: 'medium', heavy: 'high' };

/** Biggest models: Opus, Codex's Astra, Gemini Pro, anything that thinks. */
const HEAVY = /opus|astra|(^|[-_.])pro([-_.]|$)|thinking|ultra/i;
/** Fast and cheap ones: Haiku, Luna, minis, Gemini Flash at low effort. */
const LIGHT = /haiku|luna|flash[-_.]low|(^|[-_.])(mini|nano|lite)([-_.]|$)/i;

/** Rough weight of a model, from its name; a name the rules do not know is "standard". */
export function tierOf(model: Pick<ModelInfo, 'id'>): Tier {
  if (HEAVY.test(model.id)) return 'heavy';
  if (LIGHT.test(model.id)) return 'light';
  return 'standard';
}

/** [major, minor] of the first two numbers in the id: claude-opus-5-5 → [5, 5], gpt-6.1-sol → [6, 1]. */
function version(id: string): [number, number] {
  // "120b" is a parameter count, not a version.
  const numbers = (id.replace(/\d+b/gi, '').match(/\d+/g) ?? []).map(Number);
  return [numbers[0] ?? 0, numbers[1] ?? 0];
}

/** Gemini slugs carry their effort in the name: a model whose suffix is the tier's own effort fits it best. */
const fits = (model: ModelInfo, tier: Tier): boolean => model.id.endsWith(`-${TIER_EFFORT[tier]}`);

/** `a` is the better pick for `tier` than `b`: the newer version, then the one that fits the tier's effort. */
const better = (a: ModelInfo, b: ModelInfo, tier: Tier): boolean => {
  const [a1, a2] = version(a.id);
  const [b1, b2] = version(b.id);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return fits(a, tier) && !fits(b, tier);
};

/** The effort a model should run at for a tier: the tier's own level when accepted, else the model's default. */
function effortFor(model: ModelInfo, tier: Tier): string | undefined {
  if (model.efforts.length === 0) return undefined;
  return model.efforts.includes(TIER_EFFORT[tier]) ? TIER_EFFORT[tier] : model.defaultEffort;
}

/** Models of other makers that a CLI also offers (Antigravity serves Claude and GPT-OSS next to Gemini) rank after its own. */
const NATIVE: Partial<Record<AgentName, RegExp>> = { antigravity: /^gemini/i };

/** The newest model of each tier a CLI really lists; a tier with none borrows the nearest tier that has one. */
function agentTiers(agent: AgentName, models: readonly ModelInfo[]): Partial<Record<Tier, Omit<ModelChoice, 'tier'>>> {
  const best: Partial<Record<Tier, ModelInfo>> = {};
  const isNative = (model: ModelInfo) => !NATIVE[agent] || NATIVE[agent]!.test(model.id);
  for (const model of models) {
    const tier = tierOf(model);
    const current = best[tier];
    if (!current || (isNative(model) && !isNative(current)) || (isNative(model) === isNative(current) && better(model, current, tier))) best[tier] = model;
  }
  const have = TIERS.filter((tier) => best[tier]);
  const out: Partial<Record<Tier, Omit<ModelChoice, 'tier'>>> = {};
  for (const [index, tier] of TIERS.entries()) {
    if (!have.length) break;
    const from = have.reduce((a, b) => (Math.abs(TIERS.indexOf(b) - index) < Math.abs(TIERS.indexOf(a) - index) ? b : a));
    const model = best[from]!;
    out[tier] = { model: model.id, effort: effortFor(model, tier) };
  }
  return out;
}

/** What the router may pick per agent and tier, from the models the CLIs actually list. An agent with no models has no entries. */
export function buildCatalog(listed: ModelCatalog): Partial<Record<AgentName, Partial<Record<Tier, Omit<ModelChoice, 'tier'>>>>> {
  return Object.fromEntries(AGENT_NAMES.map((agent) => [agent, agentTiers(agent, listed[agent].models)]));
}

/** `catalog` with the entries of `built` laid over it. */
export function overlayCatalog(catalog: Catalog, built: ReturnType<typeof buildCatalog>): void {
  for (const agent of AGENT_NAMES) {
    for (const tier of TIERS) {
      const entry = built[agent]?.[tier];
      if (entry) catalog[agent][tier] = entry;
    }
  }
}
