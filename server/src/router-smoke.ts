/** Offline checks for the auto-router: rules, policy, Haiku fallback and model precedence. */
import assert from 'node:assert/strict';
import { DEFAULT_CATALOG, loadCatalog } from './router/catalog.ts';
import { parseClassification, type Classifier } from './router/classify.ts';
import { autoRoute } from './router/index.ts';
import { decide } from './router/policy.ts';
import { classifyByRules, CONFIDENT, normalize } from './router/rules.ts';
import { RunContext } from './run.ts';
import type { RunConfig } from './types.ts';

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
const small = decide('edit', 'light', cat);
assert.equal(small.mode, 'pair');
assert.equal(small.coder, 'codex');
assert.equal(small.maxRounds, 2);
assert.equal(small.models.codex?.coder?.model, cat.codex.light.model);
assert.equal(small.models.claude?.reviewer?.tier, 'light');

const refactor = decide('refactor', 'heavy', cat);
assert.equal(refactor.coder, 'claude');
assert.equal(refactor.models.claude?.coder?.model, 'opus');
assert.equal(refactor.models.codex?.reviewer?.tier, 'standard', 'reviewer runs one tier below the coder');
assert.equal(decide('bugfix', 'heavy', cat).coder, 'codex');

const design = decide('design', 'heavy', cat);
assert.equal(design.mode, 'debate');
assert.equal(design.models.claude?.thinker?.tier, 'heavy');
assert.equal(design.models.codex?.thinker?.tier, 'heavy');
assert.equal(design.models.claude?.judge?.tier, 'standard');
const explain = decide('explain', 'heavy', cat);
assert.equal(explain.maxRounds, 1);
assert.equal(explain.models.claude?.thinker?.tier, 'standard');

// Catalog: unknown Codex slugs and unsafe values fall back to the CLI default.
const checked = loadCatalog({}, new Set(['gpt-6-sol']));
assert.equal(checked.codex.standard.model, 'gpt-6-sol');
assert.equal(checked.codex.light.model, undefined);
assert.equal(checked.codex.light.effort, 'low');
assert.equal(loadCatalog({}, undefined).codex.heavy.model, 'gpt-6-astra', 'no cache: trust the catalog');

// Haiku reply parsing.
assert.deepEqual(parseClassification('ok\n```json\n{"taskType":"design","complexity":"heavy"}\n```'), { taskType: 'design', complexity: 'heavy' });
assert.equal(parseClassification('```json\n{"taskType":"deploy","complexity":"heavy"}\n```'), undefined);
assert.equal(parseClassification('{"taskType":"edit","complexity":"light"}'), undefined, 'unfenced JSON must not count');
assert.equal(parseClassification('```json\n{"taskType":\n```'), undefined);

// Haiku is only asked when the rules are unsure, and a failed call keeps the rules' answer.
let asked = 0;
const haiku = (answer: Awaited<ReturnType<Classifier>>): Classifier => async () => {
  asked++;
  return answer;
};
const usage = { inputTokens: 900, outputTokens: 20, cachedInputTokens: 0 };
const clear = await autoRoute('Sửa typo trong README', { classify: haiku(undefined), catalog: cat });
assert.equal(asked, 0);
assert.equal(clear.route.source, 'rules');

const unclear = await autoRoute('làm cái trang đẹp hơn', { classify: haiku({ taskType: 'design', complexity: 'light', usage }), catalog: cat });
assert.equal(asked, 1);
assert.equal(unclear.route.source, 'haiku');
assert.equal(unclear.mode, 'debate');
assert.deepEqual(unclear.usage, usage);
assert.match(unclear.route.reason, /Haiku/);

const failed = await autoRoute('làm cái trang đẹp hơn', { classify: haiku(undefined), catalog: cat });
assert.equal(failed.route.source, 'rules');
assert.equal(failed.mode, 'pair');

// Model precedence inside a run: manual per-agent model > routed per-role model > CLI default.
const routed = await autoRoute('Refactor toàn bộ module auth, tách file và migrate sang kiến trúc mới', { classify: false, catalog: cat });
const config: RunConfig = { ...routed, prompt: 'x', cwd: '.', turnTimeoutMin: 1, models: {}, route: routed.route };
const ctx = new RunContext(config);
assert.deepEqual(ctx.modelFor('claude', 'coder'), { model: 'opus', effort: 'high' });
assert.deepEqual(ctx.modelFor('codex', 'reviewer'), { model: cat.codex.standard.model, effort: 'medium' });
assert.deepEqual(ctx.modelFor('codex', 'thinker'), { model: undefined, effort: undefined });
config.models = { claude: 'sonnet' };
assert.deepEqual(ctx.modelFor('claude', 'coder'), { model: 'sonnet' });

console.log('router smoke: ok');
