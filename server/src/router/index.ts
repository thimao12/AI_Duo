import type { Usage } from '../agents/types.ts';
import type { Mode, RoutePlan } from '../types.ts';
import { loadCatalog, type Catalog } from './catalog.ts';
import { classifyWithHaiku, type Classifier } from './classify.ts';
import { decide, describe, type Decision } from './policy.ts';
import { classifyByRules, CONFIDENT } from './rules.ts';

export interface RouteResult extends Omit<Decision, 'models'> {
  route: RoutePlan;
  /** Tokens spent by the Haiku classifier, if it ran. */
  usage?: Usage;
}

export interface RouteOptions {
  classify?: Classifier | false;
  catalog?: Catalog;
  signal?: AbortSignal;
  mode?: Mode;
}

/** Keyword rules first (free); only an unclear prompt costs one small Haiku call. */
export async function autoRoute(prompt: string, { classify = classifyWithHaiku, catalog = loadCatalog(), signal, mode = 'code' }: RouteOptions = {}): Promise<RouteResult> {
  const rules = classifyByRules(prompt);
  let { taskType, complexity } = rules;
  let source: RoutePlan['source'] = 'rules';
  let usage: Usage | undefined;
  if (classify && rules.confidence < CONFIDENT) {
    const m = await classify(prompt, signal);
    if (m) {
      ({ taskType, complexity, usage } = m);
      source = 'haiku';
    }
  }
  const { models, ...decision } = decide(taskType, complexity, catalog, mode);
  const via = source === 'haiku' ? 'Haiku phân loại (luật không chắc chắn)' : `luật từ khoá, độ tin cậy ${rules.confidence}`;
  return {
    ...decision,
    route: { taskType, complexity, source, reason: `${describe(taskType, complexity, { models, ...decision })}\nNguồn: ${via}`, models },
    usage,
  };
}
