/**
 * Smoke test for the per-CLI manual configuration: validation, persistence, precedence of the
 * binary (env > settings > PATH > known), extra arguments and env reaching the spawned CLI,
 * defaults for runs, and the HTTP routes.
 *   pnpm --filter server test:cli-settings
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo cli settings smoke '));
const repo = path.join(temp, 'repo');
const emptyDir = path.join(temp, 'empty');
const binDir = path.join(temp, 'bin dir');
await Promise.all([mkdir(repo), mkdir(emptyDir), mkdir(binDir)]);
const settingsPath = path.join(temp, 'nested', 'settings.json');

const saved = { PATH: process.env.PATH, CLAUDE_BIN: process.env.CLAUDE_BIN, CODEX_BIN: process.env.CODEX_BIN, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA };
const originalPath = process.env.PATH ?? '';
process.env.AI_DUO_SETTINGS_FILE = settingsPath;
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([temp]);
process.env.HOME = temp;
process.env.USERPROFILE = temp;
process.env.LOCALAPPDATA = path.join(temp, 'local app data');
delete process.env.CLAUDE_BIN;
delete process.env.CODEX_BIN;

const [settings, cli, { cliSettingsRoutes }, { resolveBin }, { agentEnv }, { codex }, { agents }, { RunService }, { roleModel }] = await Promise.all([
  import('./settings.ts'),
  import('./cli-settings.ts'),
  import('./routes/cli-settings.ts'),
  import('./agents/bins.ts'),
  import('./agents/billing.ts'),
  import('./agents/codex.ts'),
  import('./agents/index.ts'),
  import('./service.ts'),
  import('./modes/pipeline.ts'),
]);

const app = cliSettingsRoutes();
const put = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  app.request('/api/cli-settings', { method: 'PUT', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const nodeBin = process.execPath; // a real, absolute file that answers --version

/** A fake Codex CLI: JS entry plus a launcher (npm-style .cmd shim on Windows, shell script elsewhere). */
async function fakeCli(dir: string, name: string, argsFile: string): Promise<string> {
  const entry = path.join(dir, `${name}.js`);
  await writeFile(
    entry,
    [
      "const fs = require('node:fs');",
      String.raw`if (process.argv.includes('--version')) { process.stdout.write('fake ${name} 9.9.9\n'); process.exit(0); }`,
      String.raw`if (process.argv.includes('login')) { process.stdout.write('Logged in using ChatGPT\n'); process.exit(0); }`,
      "const args = process.argv.slice(2);",
      `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args, marker: process.env.AI_DUO_SMOKE_MARKER ?? null, metered: process.env.OPENAI_API_KEY ?? null }));`,
      "const output = args.indexOf('-o');",
      "if (output >= 0) fs.writeFileSync(args[output + 1], 'fake done');",
      String.raw`process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');`,
    ].join('\n'),
  );
  if (process.platform === 'win32') {
    const shim = path.join(dir, `${name}.cmd`);
    await writeFile(shim, `"%~dp0%\\${name}.js" %*\r\n`);
    return shim;
  }
  const launcher = path.join(dir, name);
  await writeFile(launcher, `#!/bin/sh\nexec "${nodeBin}" "${entry}" "$@"\n`);
  await chmod(launcher, 0o755);
  return launcher;
}

try {
  /* ---- Validation ---- */
  const bad = (input: unknown, pattern: RegExp) => {
    const result = cli.validateCliSettings(input);
    assert.equal(typeof result, 'string', `${JSON.stringify(input)} should be rejected`);
    assert.match(result as string, pattern);
  };
  const base = { claude: {}, codex: {} };
  assert.deepEqual(cli.validateCliSettings(base), base);
  assert.deepEqual(cli.validateCliSettings({}), base, 'missing sections default to empty');
  assert.deepEqual(cli.validateCliSettings({ claude: { binPath: '  ', extraArgs: [], env: {}, defaultModel: ' ' } }), base, 'empty values are dropped');
  bad(null, /đối tượng/);
  bad({ claude: { binPath: 'relative/claude' } }, /tuyệt đối/);
  bad({ claude: { binPath: `${nodeBin}\0` } }, /tuyệt đối/);
  bad({ claude: { binPath: path.join(temp, 'missing.exe') } }, /không tìm thấy/);
  bad({ claude: { binPath: temp } }, /không tìm thấy/);
  bad({ claude: { binPath: 5 } }, /chuỗi/);
  bad({ claude: { extraArgs: 'x' } }, /danh sách/);
  bad({ claude: { extraArgs: Array.from({ length: 51 }, () => 'a') } }, /danh sách/);
  bad({ claude: { extraArgs: ['x'.repeat(501)] } }, /tối đa 500/);
  bad({ claude: { extraArgs: ['a\0b'] } }, /NUL/);
  bad({ claude: { extraArgs: [1] } }, /chuỗi/);
  bad({ codex: { env: [] } }, /đối tượng/);
  bad({ codex: { env: { '1BAD': 'x' } } }, /không hợp lệ/);
  bad({ codex: { env: { 'A-B': 'x' } } }, /không hợp lệ/);
  bad({ codex: { env: JSON.parse('{"__proto__":"x"}') } }, /không hợp lệ/);
  bad({ codex: { env: { constructor: 'x' } } }, /không hợp lệ/);
  bad({ codex: { env: { prototype: 'x' } } }, /không hợp lệ/);
  bad({ codex: { env: { A: 'x'.repeat(2001) } } }, /tối đa 2000/);
  bad({ codex: { env: { A: 'x\0' } } }, /NUL/);
  bad({ codex: { env: { A: 1 } } }, /chuỗi/);
  bad({ codex: { env: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`K${i}`, 'v'])) } }, /tối đa 50/);
  bad({ claude: { defaultModel: '--danger' } }, /defaultModel/);
  bad({ claude: { defaultEffort: 'HIGH!' } }, /defaultEffort/);
  bad({ turnTimeoutMin: 0 }, /turnTimeoutMin/);
  bad({ turnTimeoutMin: 241 }, /turnTimeoutMin/);
  bad({ turnTimeoutMin: 1.5 }, /turnTimeoutMin/);
  bad({ turnTimeoutMin: '30' }, /turnTimeoutMin/);
  bad({ testCommand: 'x'.repeat(501) }, /testCommand/);
  bad({ testCommand: 'npm test\0' }, /testCommand/);
  bad({ testCommand: 5 }, /testCommand/);

  const good = cli.validateCliSettings({
    claude: { binPath: ` ${nodeBin} `, extraArgs: ['--verbose', '--max-turns', '5'], env: { FOO: 'bar' }, defaultModel: 'sonnet', defaultEffort: 'high' },
    codex: {},
    turnTimeoutMin: 240,
    testCommand: ' npm test ',
  });
  assert.deepEqual(good, {
    claude: { binPath: nodeBin, extraArgs: ['--verbose', '--max-turns', '5'], env: { FOO: 'bar' }, defaultModel: 'sonnet', defaultEffort: 'high' },
    codex: {},
    turnTimeoutMin: 240,
    testCommand: 'npm test',
  });

  // Extra arguments can never replace the permission or sandbox flags AI Duo sets itself.
  const protectedArgs = [
    '--permission-mode', '--permission-mode=bypassPermissions', '--allowedTools', '--allowedTools=Bash', '--disallowedTools', '--dangerously-skip-permissions',
    '--sandbox', '--sandbox=danger-full-access', '-s', '-sdanger-full-access', '--dangerously-bypass-approvals-and-sandbox', '--full-auto',
    'sandbox_mode="danger-full-access"', 'approval_policy=never',
  ];
  for (const arg of protectedArgs) bad({ codex: { extraArgs: ['--ok', arg] } }, /extraArgs\[1\].*không được phép/);
  assert.equal(typeof cli.validateCliSettings({ codex: { extraArgs: ['--model-provider', 'x', '--color', 'never'] } }), 'object');

  /* ---- Old files and persistence ---- */
  assert.deepEqual(settings.getCliSettingsSync(), base, 'no file: defaults');
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ roles: [], pipelines: [] }));
  process.env.AI_DUO_SETTINGS_FILE = `${settingsPath}.old`;
  await writeFile(`${settingsPath}.old`, JSON.stringify({ roles: settings.defaultRoles(), pipelines: [] }));
  const old = await settings.loadSettings();
  assert.deepEqual(old.cli, base, 'a settings.json without cli loads with defaults');
  assert.equal(old.roles.length, 6);
  await writeFile(`${settingsPath}.old`, JSON.stringify({ cli: { claude: { extraArgs: ['--full-auto'] } } }));
  assert.deepEqual((await settings.loadSettings()).cli, base, 'an invalid stored cli falls back to defaults');
  process.env.AI_DUO_SETTINGS_FILE = settingsPath;
  await rm(settingsPath, { force: true });

  assert.equal(await settings.setCliSettings({ claude: { binPath: 'nope' } }), 'claude.binPath phải là đường dẫn tuyệt đối tới file chạy được.');
  const stored = await settings.setCliSettings(good);
  assert.deepEqual(stored, good);
  assert.deepEqual(settings.getCliSettingsSync(), good, 'the in-memory snapshot follows a save');
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')).cli, good);
  const rolesBefore = (await settings.getRoles()).length;
  await settings.setRoles(await settings.getRoles());
  assert.deepEqual(settings.getCliSettingsSync(), good, 'saving roles keeps the cli settings');
  assert.equal((await settings.getRoles()).length, rolesBefore);
  assert.deepEqual(await settings.getCliSettings(), good);
  await settings.setCliSettings(base);

  /* ---- Binary precedence: env > settings > PATH > known ---- */
  const pathBin = await fakeCli(binDir, 'claude', path.join(temp, 'path-args.json'));
  const envBin = path.join(temp, 'env-claude.exe');
  await writeFile(envBin, '');
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  assert.equal(resolveBin('claude').source, 'path');
  assert.equal(resolveBin('claude').resolvedFrom, pathBin);

  await settings.setCliSettings({ claude: { binPath: nodeBin } });
  assert.equal(resolveBin('claude').source, 'settings', 'settings beat PATH');
  assert.equal(resolveBin('claude').cmd, nodeBin);

  process.env.CLAUDE_BIN = envBin;
  assert.equal(resolveBin('claude').source, 'env', 'the env variable beats settings');
  assert.equal(resolveBin('claude').cmd, envBin);
  delete process.env.CLAUDE_BIN;

  await settings.setCliSettings(base);
  assert.equal(resolveBin('claude').source, 'path');
  process.env.PATH = emptyDir;
  const none = resolveBin('codex');
  assert.equal(none.source, 'none');
  assert.equal(none.cmd, 'codex');
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

  /* ---- Env merge ---- */
  await settings.setCliSettings({ claude: { env: { AI_DUO_SMOKE_MARKER: 'hello', ANTHROPIC_API_KEY: 'sk-metered', PATH_EXTRA: 'x' } } });
  const claudeEnv = agentEnv(resolveBin('claude'));
  assert.equal(claudeEnv.AI_DUO_SMOKE_MARKER, 'hello');
  assert.equal(claudeEnv.PATH_EXTRA, 'x');
  assert.equal(claudeEnv.ANTHROPIC_API_KEY, undefined, 'a saved variable cannot re-enable metered billing');
  assert.equal(agentEnv(resolveBin('codex')).AI_DUO_SMOKE_MARKER, undefined, 'env is per CLI');

  /* ---- extraArgs and env reach the spawned CLI, prompt stays on stdin ---- */
  const codexDir = path.join(temp, 'codex bin');
  await mkdir(codexDir);
  const argsFile = path.join(temp, 'codex-args.json');
  const codexBin = await fakeCli(codexDir, 'codex', argsFile);
  await settings.setCliSettings({ codex: { binPath: codexBin, extraArgs: ['--color', 'never'], env: { AI_DUO_SMOKE_MARKER: 'codex-env' } } });
  const result = await codex.run({ prompt: 'do it', cwd: repo, role: 'coder', permission: 'read', signal: new AbortController().signal, onEvent: () => {} });
  assert.equal(result.finalText, 'fake done');
  const seen = JSON.parse(await readFile(argsFile, 'utf8')) as { args: string[]; marker: string | null };
  assert.equal(seen.marker, 'codex-env');
  const at = seen.args.indexOf('--color');
  assert.ok(at > 0 && seen.args[at + 1] === 'never', 'extra arguments are passed');
  assert.equal(seen.args.at(-1), '-', 'the prompt marker stays last');
  assert.equal(seen.args[seen.args.indexOf('-s') + 1], 'read-only', 'the sandbox flag is untouched');

  /* ---- Detect route ---- */
  const detect = async (name: string) => app.request(`/api/cli-settings/detect/${name}`);
  await settings.setCliSettings({ claude: { binPath: nodeBin } });
  const found = await (await detect('claude')).json();
  assert.equal(found.name, 'claude');
  assert.equal(found.source, 'settings');
  assert.equal(found.resolvedPath, nodeBin);
  assert.match(found.version, /^v\d+/);
  assert.equal(found.error, null);
  process.env.CLAUDE_BIN = envBin;
  const viaEnv = await (await detect('claude')).json();
  assert.equal(viaEnv.source, 'env', JSON.stringify(viaEnv));
  delete process.env.CLAUDE_BIN;
  await settings.setCliSettings(base);
  process.env.PATH = emptyDir;
  const missing = await (await detect('codex')).json();
  assert.deepEqual({ ...missing, error: typeof missing.error }, { name: 'codex', resolvedPath: null, source: 'none', version: null, error: 'string' });
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  const viaPath = await (await detect('claude')).json();
  assert.equal(viaPath.source, 'path');
  assert.equal(viaPath.version, 'fake claude 9.9.9');
  assert.equal((await detect('gemini')).status, 400);

  /* ---- Routes ---- */
  assert.deepEqual(await (await app.request('/api/cli-settings')).json(), { cli: base });
  const saved1 = await put({ cli: { claude: { binPath: nodeBin, defaultModel: 'haiku' }, turnTimeoutMin: 45 } });
  assert.equal(saved1.status, 200);
  const body1 = await saved1.json();
  assert.deepEqual(body1, { cli: { claude: { binPath: nodeBin, defaultModel: 'haiku' }, codex: {}, turnTimeoutMin: 45 } });
  assert.deepEqual(await (await app.request('/api/cli-settings')).json(), body1);
  const invalid = await put({ cli: { claude: { binPath: 'relative' } } });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /tuyệt đối/);
  assert.deepEqual(await (await app.request('/api/cli-settings')).json(), body1, 'a rejected save changes nothing');
  assert.equal((await put({ nope: 1 })).status, 400);
  assert.equal((await put('{ not json')).status, 400);
  assert.equal((await put({ cli: { testCommand: 'x'.repeat(70 * 1024) } })).status, 413);
  assert.equal((await put({ cli: base }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await put({ cli: base }, {})).status, 415);

  /* ---- Defaults for runs ---- */
  await settings.setCliSettings({ claude: { defaultModel: 'opus', defaultEffort: 'high' }, codex: { defaultModel: 'gpt-x' }, turnTimeoutMin: 90, testCommand: 'npm run check' });
  for (const name of ['claude', 'codex'] as const) {
    agents[name].check = () => Promise.resolve({ agent: name, path: name, version: 'fake', auth: 'ok' });
    agents[name].run = () => Promise.resolve({ finalText: 'ok' });
  }
  const service = new RunService({ app: 'smoke' });
  const start = async (extra: Record<string, unknown>) => (await service.start({ mode: 'code', prompt: 'hello', cwd: repo, permission: 'read', ...extra })).done;
  const explicit = (await start({ coder: 'claude' })).config;
  assert.equal(explicit.models?.claude, 'opus');
  assert.equal(explicit.efforts?.claude, 'high');
  assert.equal(explicit.turnTimeoutMin, 90);
  assert.equal(explicit.testCommand, 'npm run check');
  const given = (await start({ coder: 'claude', models: { claude: 'haiku' }, turnTimeoutMin: 10, testCommand: 'make' })).config;
  assert.equal(given.models?.claude, 'haiku', 'the request model wins');
  assert.equal(given.efforts?.claude, undefined, 'a default effort does not follow a model chosen in the request');
  assert.equal(given.turnTimeoutMin, 10);
  assert.equal(given.testCommand, 'make');
  const codexRun = (await start({ coder: 'codex' })).config;
  assert.equal(codexRun.models?.codex, 'gpt-x');
  assert.equal(codexRun.efforts?.codex, undefined);
  await settings.setCliSettings(base);
  const plain = (await start({ coder: 'claude' })).config;
  assert.equal(plain.models?.claude, undefined);
  assert.equal(plain.turnTimeoutMin, 30);
  assert.equal(plain.testCommand, undefined);

  // Roles: their own model wins; an empty one falls back to the CLI default.
  await settings.setCliSettings({ claude: { defaultModel: 'opus', defaultEffort: 'low' } });
  const [code, ask] = [(await settings.getRoles()).find((r) => r.id === 'code')!, { ...(await settings.getRoles())[0], model: '', effort: '' }];
  assert.deepEqual(roleModel({}, code, 'claude'), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(roleModel({}, ask, 'claude'), { model: 'opus', effort: 'low' });
  assert.deepEqual(roleModel({ models: { claude: 'haiku' } }, ask, 'claude'), { model: 'haiku', effort: undefined });

  console.log('PASS cli settings: validation, precedence, extra args, env, defaults and routes');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.AI_DUO_SETTINGS_FILE;
  delete process.env.AI_DUO_DATA_DIR;
  delete process.env.AI_DUO_ALLOWED_ROOTS;
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);
}
