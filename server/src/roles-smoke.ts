/**
 * Smoke test for roles and pipelines: defaults, validation, atomic settings, the HTTP routes,
 * permission mapping for both agents, template rendering and the agent of a saved run.
 *   pnpm --filter server test:roles
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo roles smoke '));
const settingsPath = path.join(temp, 'nested', 'settings.json');
process.env.AI_DUO_SETTINGS_FILE = settingsPath;
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');

const [settings, { rolesRoutes }, { renderTemplate }, { permissionArgs }, { sandboxFor }, { runAgent }, models] = await Promise.all([
  import('./settings.ts'),
  import('./routes/roles.ts'),
  import('./prompts/index.ts'),
  import('./agents/claude.ts'),
  import('./agents/codex.ts'),
  import('./store.ts'),
  import('./models.ts'),
]);

const JSON_HEADERS = { 'content-type': 'application/json' };

try {
  // ---- Defaults: six roles, valid against the same rules as saved ones.
  const defaults = await settings.getRoles();
  assert.deepEqual(defaults.map((r) => r.id), ['plan', 'review', 'code', 'test', 'debug', 'ask']);
  assert.ok(Array.isArray(settings.validateRoles(defaults)));
  assert.ok(defaults.every((r) => r.template.includes('{{task}}') && r.description));
  assert.deepEqual(defaults.filter((r) => r.permission === 'edit').map((r) => r.id), ['code', 'debug']);
  assert.deepEqual(defaults.filter((r) => r.gradable).map((r) => r.id), ['review', 'test']);
  assert.equal(existsSync(settingsPath), false, 'reading defaults does not create the file');

  // ---- Validation.
  const role = { ...defaults[0] };
  const bad = (patch: object, pattern: RegExp) => {
    const result = settings.validateRoles([{ ...role, ...patch }]);
    assert.equal(typeof result, 'string', JSON.stringify(patch));
    assert.match(result as string, pattern);
  };
  bad({ id: 'Bad_Id' }, /roles\[0\]\.id/);
  bad({ id: 'x'.repeat(33) }, /roles\[0\]\.id/);
  bad({ agent: 'gpt' }, /agent/);
  bad({ permission: 'write' }, /permission/);
  bad({ model: '--flag' }, /Invalid roles\[0\]\.model/);
  bad({ model: 5 }, /valid model name/);
  bad({ effort: 'HIGH!' }, /Invalid roles\[0\]\.effort/);
  bad({ template: '' }, /template/);
  bad({ template: 'x'.repeat(settings.MAX_TEMPLATE + 1) }, /template/);
  bad({ gradable: 'yes' }, /gradable/);
  assert.match(settings.validateRoles([role, role]) as string, /Duplicate role id/);
  assert.match(settings.validateRoles([]) as string, /roles must be/);
  assert.match(settings.validateRoles('nope') as string, /roles must be/);
  assert.equal(models.modelNameProblem('opus', 'm'), undefined);
  assert.match(models.modelNameProblem('-x', 'm') ?? '', /Invalid m/);

  // ---- Saving, reading back, reset.
  const custom = { ...role, id: 'my-role', name: 'Mine', icon: 'S', model: ' sonnet ', effort: '' };
  const saved = await settings.setRoles([...defaults, custom]);
  assert.ok(Array.isArray(saved));
  assert.equal((await settings.getRoles()).at(-1)?.model, 'sonnet', 'model is trimmed');
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).roles.length, 7);
  assert.match((await settings.setRoles([{ ...role, id: 'BAD' }])) as string, /id/);
  assert.equal((await settings.getRoles()).length, 7, 'a rejected save changes nothing');

  const pipelines = await settings.setPipelines([{ id: 'flow', name: 'Flow', steps: [{ roleId: 'my-role' }, { roleId: 'review', onFail: 0, maxLoops: 3 }] }]);
  assert.ok(Array.isArray(pipelines));
  const badPipeline = async (steps: unknown, pattern: RegExp) => assert.match((await settings.setPipelines([{ id: 'p', name: 'P', steps }])) as string, pattern);
  await badPipeline([{ roleId: 'nope' }], /existing role/);
  await badPipeline([{ roleId: 'code', onFail: 1 }], /onFail/);
  await badPipeline([{ roleId: 'code', maxLoops: 11 }], /maxLoops/);
  await badPipeline([], /steps/);
  assert.match((await settings.setRoles(defaults)) as string, /still uses a role/, 'a role used by a pipeline cannot be removed');

  const reset = await settings.resetRoles();
  assert.deepEqual(reset.map((r) => r.id), ['plan', 'review', 'code', 'test', 'debug', 'ask', 'my-role'], 'reset restores defaults and keeps roles pipelines use');
  await settings.setPipelines([]);
  assert.equal((await settings.resetRoles()).length, 6);

  // ---- HTTP routes.
  const api = rolesRoutes();
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = JSON_HEADERS) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    return api.request(url, { method, headers, body: body === undefined ? undefined : payload });
  };
  const got = await (await call('GET', '/api/roles')).json();
  assert.equal(got.roles.length, 6);
  const put = await call('PUT', '/api/roles', { roles: [{ ...got.roles[0], name: 'Renamed' }, ...got.roles.slice(1)] });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).roles[0].name, 'Renamed');
  assert.equal((await call('PUT', '/api/roles', got.roles)).status, 200, 'a bare array is accepted');
  const invalid = await call('PUT', '/api/roles', { roles: [{ ...role, agent: 'x' }] });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /agent/);
  assert.equal((await call('PUT', '/api/roles', '{oops')).status, 400);
  assert.equal((await call('PUT', '/api/roles', { other: 1 })).status, 400);
  assert.equal((await call('PUT', '/api/roles', { roles: [] }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call('PUT', '/api/roles', 'x'.repeat(settings.MAX_SETTINGS_BYTES + 1))).status, 413);
  assert.equal((await (await call('POST', '/api/roles/reset')).json()).roles[0].name, 'Plan');
  const stored = await call('PUT', '/api/pipelines', { pipelines: [{ id: 'a-b', name: 'AB', steps: [{ roleId: 'plan' }, { roleId: 'code' }] }] });
  assert.equal(stored.status, 200);
  assert.equal((await (await call('GET', '/api/pipelines')).json()).pipelines[0].steps.length, 2);
  assert.equal((await call('PUT', '/api/pipelines', { pipelines: [{ id: 'A B', name: 'x', steps: [{ roleId: 'plan' }] }] })).status, 400);
  await settings.setPipelines([]);

  // ---- Permission mapping: an explicit permission overrides the internal role; absent keeps the old behaviour.
  const has = (args: string[], flag: string, value: string) => args[args.indexOf(flag) + 1]?.split(',').includes(value);
  assert.deepEqual(permissionArgs('coder'), permissionArgs('thinker', 'edit'));
  assert.deepEqual(permissionArgs('thinker'), permissionArgs('coder', 'read'));
  assert.deepEqual(permissionArgs('reviewer'), permissionArgs('reviewer', 'read'));
  assert.equal(has(permissionArgs('thinker', 'edit'), '--allowedTools', 'Edit'), true);
  assert.equal(has(permissionArgs('coder', 'read'), '--disallowedTools', 'Write'), true);
  assert.equal(has(permissionArgs('thinker'), '--allowedTools', 'Bash'), false);
  assert.equal(sandboxFor('thinker'), 'read-only');
  assert.equal(sandboxFor('coder'), 'workspace-write');
  assert.equal(sandboxFor('reviewer'), 'workspace-write');
  assert.equal(sandboxFor('thinker', 'edit'), 'workspace-write');
  assert.equal(sandboxFor('coder', 'read'), 'read-only');
  assert.equal(sandboxFor('reviewer', 'read'), 'workspace-write');

  // ---- Templates: one pass, values are never expanded again.
  assert.equal(renderTemplate('A {{task}} / {{ prev }} / {{missing}}', { task: 'T {{prev}}', prev: 'P' }), 'A T {{prev}} / P / {{missing}}');
  assert.equal(renderTemplate('{{code-out}}', { 'code-out': 'x' }), 'x');
  assert.equal(renderTemplate('{{constructor}}', {}), '{{constructor}}');

  // ---- Old records derive their agent from the config.
  const base = { mode: 'code' as const, prompt: 'p', cwd: temp, maxRounds: 2, judge: 'claude' as const, coder: 'codex' as const, turnTimeoutMin: 1 };
  assert.equal(runAgent(base), 'codex');
  assert.equal(runAgent({ ...base, mode: 'debate', coder: 'codex', judge: 'claude' }), 'claude');
  assert.equal(runAgent({ ...base, coder: undefined as never }), 'claude');

  console.log('PASS roles: defaults, validation, storage, routes, permission mapping, templates, run agent');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);
}
