/** Offline checks for the auto-router: rules, policy, Haiku fallback and model precedence. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Classifier } from './router/classify.ts';
import type { RunConfig } from './types.ts';

const dataDir = await mkdtemp(path.join(tmpdir(), 'ai-duo-router-runs-'));
process.env.AI_DUO_DATA_DIR = dataDir;

try {
  const [catalogModule, classifyModule, routerModule, policyModule, rulesModule, { RunContext }] = await Promise.all([
    import('./router/catalog.ts'),
    import('./router/classify.ts'),
    import('./router/index.ts'),
    import('./router/policy.ts'),
    import('./router/rules.ts'),
    import('./run.ts'),
  ]);
  const { DEFAULT_CATALOG, loadCatalog } = catalogModule;
  const { parseClassification } = classifyModule;
  const { autoRoute } = routerModule;
  const { decide } = policyModule;
  const { classifyByRules, CONFIDENT, normalize } = rulesModule;

  assert.equal(normalize('Sửa LỖI đăng nhập'), 'sua loi dang nhap');

  // [prompt, taskType, complexity, confident?]
  const cases = [
    ['Sửa typo trong README', 'edit', 'light', true],
    ['fix typo in the footer comment', 'bugfix', 'light', true],
    ['Sửa lỗi crash khi upload file rỗng, bị exception ở uploader.ts', 'bugfix', 'standard', true],
    ['Refactor toàn bộ module auth, tách file và migrate sang kiến trúc mới', 'refactor', 'heavy', true],
    ['So sánh Redis và Memcached, nên dùng cái nào cho cache phiên đăng nhập? Đánh giá ưu nhược', 'design', 'standard', true],
    ['Giải thích tại sao hàm debounce này hoạt động như thế nào?', 'explain', 'light', true],
    ['làm cái trang đẹp hơn', 'edit', 'standard', false],
  ] as const;
  for (const [prompt, taskType, complexity, confident] of cases) {
    const c = classifyByRules(prompt);
    assert.equal(c.taskType, taskType, `${prompt}: ${JSON.stringify(c)}`);
    assert.equal(c.complexity, complexity, `${prompt}: ${JSON.stringify(c)}`);
    assert.equal(c.confidence >= CONFIDENT, confident, `${prompt}: ${JSON.stringify(c)}`);
  }

  // Policy.
  const cat = DEFAULT_CATALOG;
  const small = decide('edit', 'light', cat, 'code');
  assert.equal(small.mode, 'code');
  assert.equal(small.coder, 'codex');
  assert.equal(small.maxRounds, 2);
  assert.equal(small.models.codex?.coder?.model, cat.codex.light.model);
  assert.equal(small.reviewer, 'codex');
  assert.equal(small.models.codex?.reviewer?.model, small.models.codex?.coder?.model);

  const refactor = decide('refactor', 'heavy', cat);
  assert.equal(refactor.coder, 'claude');
  assert.equal(refactor.models.claude?.coder?.model, 'opus');
  assert.equal(refactor.models.codex?.reviewer?.tier, 'standard', 'reviewer runs one tier below the coder');
  assert.equal(decide('bugfix', 'heavy', cat).coder, 'codex');

  const design = decide('design', 'heavy', cat, 'code');
  assert.equal(design.mode, 'code');
  assert.equal(design.coder, 'claude');
  assert.equal(design.reviewer, 'codex');
  assert.equal(design.maxRounds, 2);
  const explain = decide('explain', 'heavy', cat, 'code');
  assert.equal(explain.mode, 'code');
  assert.equal(explain.coder, 'claude');
  const plan = decide('refactor', 'heavy', cat, 'plan');
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.coder, 'claude');
  assert.equal(plan.reviewer, 'codex');
  assert.equal(plan.models.claude?.thinker?.tier, 'heavy');
  assert.equal(plan.models.codex?.thinker?.tier, 'standard');

  // Catalog: unknown Codex slugs and unsafe values fall back to the CLI default.
  const checked = loadCatalog({}, new Set(['gpt-6-sol']));
  assert.equal(checked.codex.standard.model, 'gpt-6-sol');
  assert.equal(checked.codex.light.model, undefined);
  assert.equal(checked.codex.light.effort, 'low');
  assert.equal(loadCatalog({}, null).codex.heavy.model, 'gpt-6-astra', 'no cache: trust the catalog');

  // Haiku reply parsing.
  assert.deepEqual(parseClassification('ok\n```json\n{"taskType":"design","complexity":"heavy"}\n```'), { taskType: 'design', complexity: 'heavy' });
  assert.equal(parseClassification('```json\n{"taskType":"deploy","complexity":"heavy"}\n```'), undefined);
  assert.equal(parseClassification('{"taskType":"edit","complexity":"light"}'), undefined, 'unfenced JSON must not count');
  assert.equal(parseClassification('```json\n{"taskType":\n```'), undefined);

  // Haiku is only asked when the rules are unsure, and a failed call keeps the rules' answer.
  let asked = 0;
  const haiku = (answer: Awaited<ReturnType<Classifier>>): Classifier => () => {
    asked++;
    return Promise.resolve(answer);
  };
  const usage = { inputTokens: 900, outputTokens: 20, cachedInputTokens: 0 };
  const clear = await autoRoute('Sửa typo trong README', { classify: haiku(undefined), catalog: cat });
  assert.equal(asked, 0);
  assert.equal(clear.route.source, 'rules');

  const unclear = await autoRoute('làm cái trang đẹp hơn', { classify: haiku({ taskType: 'design', complexity: 'light', usage }), catalog: cat, mode: 'plan' });
  assert.equal(asked, 1);
  assert.equal(unclear.route.source, 'haiku');
  assert.equal(unclear.mode, 'plan');
  assert.deepEqual(unclear.usage, usage);
  assert.match(unclear.route.reason, /Haiku/);

  const failed = await autoRoute('làm cái trang đẹp hơn', { classify: haiku(undefined), catalog: cat });
  assert.equal(failed.route.source, 'rules');
  assert.equal(failed.mode, 'code');

  // Model precedence inside a run: manual per-agent model > routed per-role model > CLI default.
  const routed = await autoRoute('Refactor toàn bộ module auth, tách file và migrate sang kiến trúc mới', { classify: false, catalog: cat, mode: 'code' });
  const config: RunConfig = { ...routed, prompt: 'x', cwd: '.', turnTimeoutMin: 1, models: {}, route: routed.route };
  const ctx = new RunContext(config);
  assert.deepEqual(ctx.modelFor('claude', 'coder'), { model: 'opus', effort: 'high' });
  assert.deepEqual(ctx.modelFor('codex', 'reviewer'), { model: cat.codex.standard.model, effort: 'medium' });
  assert.deepEqual(ctx.modelFor('codex', 'thinker'), { model: undefined, effort: undefined });
  config.models = { claude: 'sonnet' };
  assert.deepEqual(ctx.modelFor('claude', 'coder'), { model: 'sonnet' });
  await ctx.finish('done');

  // Availability: a CLI that is missing, logged out or nearly out of quota is avoided.
  const availabilityModule = await import('./router/availability.ts');
  const { evaluateAvailability, avoidedReasons, QUOTA_LIMIT_PERCENT } = availabilityModule;
  const ok = { agent: 'codex' as const, path: 'x', version: '1', auth: 'ok' as const };
  assert.deepEqual(evaluateAvailability('codex', ok, undefined), { usable: true });
  assert.equal(evaluateAvailability('codex', { ...ok, error: 'not found' }, undefined).usable, false);
  assert.match(evaluateAvailability('codex', { ...ok, auth: 'failed' }, undefined).reason ?? '', /chưa đăng nhập/);
  assert.equal(evaluateAvailability('antigravity', { ...ok, agent: 'antigravity', auth: 'unknown' }, { source: 'unavailable' }).usable, true, 'an unreadable login does not block');
  const win = (usedPercent: number, extra = {}) => ({ usedPercent, windowMinutes: 300, ...extra });
  assert.equal(QUOTA_LIMIT_PERCENT, 90);
  assert.equal(evaluateAvailability('codex', ok, { source: 'live', fiveHour: win(89), weekly: win(10) }).usable, true);
  assert.match(evaluateAvailability('codex', ok, { source: 'live', fiveHour: win(40), weekly: win(93) }).reason ?? '', /93% hạn mức tuần/);
  assert.equal(evaluateAvailability('codex', ok, { source: 'live', fiveHour: win(99, { stale: true }) }).usable, true, 'a window that already reset does not count');

  const only = (...unusable: ('claude' | 'codex' | 'antigravity')[]) => Object.fromEntries(unusable.map((n) => [n, { usable: false, reason: `${n} nope` }]));
  const coderOf = (d: ReturnType<typeof decide>) => [d.coder, d.reviewer];
  assert.deepEqual(coderOf(decide('edit', 'standard', cat, 'code')), ['codex', 'claude'], 'nothing unusable: as before');
  assert.deepEqual(coderOf(decide('edit', 'standard', cat, 'code', { availability: only('codex') })), ['claude', 'antigravity'], 'Codex out: Claude writes, Antigravity reviews');
  assert.deepEqual(coderOf(decide('refactor', 'heavy', cat, 'code', { availability: only('codex') })), ['claude', 'antigravity']);
  assert.deepEqual(coderOf(decide('edit', 'standard', cat, 'code', { availability: only('claude') })), ['codex', 'antigravity'], 'Claude out: Codex writes, Antigravity reviews');
  assert.deepEqual(coderOf(decide('edit', 'standard', cat, 'code', { availability: only('claude', 'antigravity') })), ['codex', 'codex'], 'one usable CLI reviews itself');
  assert.deepEqual(coderOf(decide('edit', 'standard', cat, 'code', { availability: only('claude', 'codex') })), ['antigravity', 'antigravity'], 'only Antigravity left');
  assert.deepEqual(coderOf(decide('edit', 'standard', cat, 'code', { availability: only('claude', 'codex', 'antigravity') })), ['codex', 'claude'], 'nothing usable: plain order, preflight reports it');
  assert.deepEqual(coderOf(decide('edit', 'standard', cat, 'code', { availability: only('codex'), images: true })), ['claude', 'claude'], 'images exclude Antigravity');
  const agyReview = decide('edit', 'standard', cat, 'code', { availability: only('codex') });
  assert.equal(agyReview.models.antigravity?.reviewer?.model, cat.antigravity.light.model, 'the reviewer runs one tier below');
  const planFallback = decide('design', 'standard', cat, 'plan', { availability: only('claude') });
  assert.deepEqual(coderOf(planFallback), ['codex', 'antigravity']);
  assert.ok(planFallback.models.codex?.thinker && planFallback.models.antigravity?.thinker);

  const fallback = await autoRoute('Sửa lỗi crash khi upload file rỗng, bị exception ở uploader.ts', { classify: false, catalog: cat, availability: only('codex') });
  assert.equal(fallback.coder, 'claude');
  assert.equal(fallback.reviewer, 'antigravity');
  assert.match(fallback.route.reason, /bỏ qua: codex nope/);
  assert.deepEqual(avoidedReasons(only('codex', 'claude')), ['codex nope', 'claude nope']);
  assert.deepEqual(avoidedReasons(undefined), []);

  // The catalog covers every agent; an Antigravity model the CLI does not list falls back to the built-in tier entry.
  const overridePath = path.join(dataDir, 'catalog.json');
  await (await import('node:fs/promises')).writeFile(overridePath, JSON.stringify({ antigravity: { heavy: { model: 'gemini-9-nope' }, light: { model: 'gemini-3.7-flash-low' } } }));
  const custom = loadCatalog({ AI_DUO_ROUTER_CATALOG: overridePath }, null);
  assert.equal(custom.antigravity.heavy.model, DEFAULT_CATALOG.antigravity.heavy.model);
  assert.equal(custom.antigravity.light.model, 'gemini-3.7-flash-low');

  console.log('router smoke: ok');
} finally {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);
}
