/**
 * Smoke test for npm .cmd CLI shims and model name validation.
 *   pnpm --filter server test:bins
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo npm shim smoke '));
const runsDir = path.join(temp, 'runs');
const repoDir = path.join(temp, 'working directory');
const emptyBinDir = path.join(temp, 'empty PATH');
await Promise.all([mkdir(runsDir), mkdir(repoDir), mkdir(emptyBinDir)]);
process.env.AI_DUO_DATA_DIR = runsDir;
process.env.AI_DUO_DEFAULT_CWD = repoDir;

const originalPath = process.env.PATH;
const originalCodexBin = process.env.CODEX_BIN;
const originalClaudeBin = process.env.CLAUDE_BIN;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalUserProfile = process.env.USERPROFILE;
const originalHome = process.env.HOME;
process.env.PATH = emptyBinDir;
process.env.LOCALAPPDATA = path.join(temp, 'local app data');
process.env.USERPROFILE = temp;
process.env.HOME = temp;
process.env.CLAUDE_BIN = path.join(temp, 'claude-missing.exe');
delete process.env.CODEX_BIN;

const [{ startServer }, { resolveBin }, { codex }] = await Promise.all([
  import('./app.ts'),
  import('./agents/bins.ts'),
  import('./agents/codex.ts'),
]);

const server = await startServer({ port: 0 });
const request = (url: string, init?: RequestInit) => fetch(`${server.url}${url}`, init);
const postConfig = (model: string) =>
  request('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'code', prompt: 'validate model', cwd: repoDir, models: { codex: model } }),
  });

try {
  for (const model of ['x & calc', '--foo']) {
    const response = await postConfig(model);
    assert.equal(response.status, 400, `${JSON.stringify(model)} should be rejected`);
    assert.match((await response.json()).error, /Invalid models\.codex/);
  }
  const validModel = await request('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'code', prompt: 'validate model', cwd: path.join(temp, 'missing cwd'), models: { codex: 'gpt-5.4-codex/high' } }),
  });
  assert.equal(validModel.status, 400);
  assert.doesNotMatch((await validModel.json()).error, /Invalid models\.codex/);

  const beforeInstall = await (await request('/api/agents')).json();
  assert.equal(beforeInstall.codex, null);
  assert.equal(beforeInstall.codexPath, 'codex', 'missing CLI should be reported as an uncached bare-name fallback');

  if (process.platform === 'win32') {
    const shimDir = path.join(temp, 'npm global bin with spaces');
    const entry = path.join(shimDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    const workDir = path.join(temp, 'repo path with spaces');
    await Promise.all([mkdir(path.dirname(entry), { recursive: true }), mkdir(workDir)]);
    await writeFile(
      entry,
      [
        "const fs = require('node:fs');",
        "if (process.argv.includes('--version')) { process.stdout.write('codex npm shim 1.2.3\\n'); process.exit(0); }",
        "if (process.argv.includes('login')) { process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0); }",
        "const args = process.argv.slice(2);",
        "const output = args.indexOf('-o');",
        "if (output >= 0) fs.writeFileSync(args[output + 1], 'npm shim completed one turn');",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'shim-smoke' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'shim reply' } }) + '\\n');",
        "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }) + '\\n');",
      ].join('\n'),
    );
    await writeFile(path.join(shimDir, 'codex.cmd'), '"%~dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');

    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ''}`;
    delete process.env.CODEX_BIN;

    const bin = resolveBin('codex');
    assert.equal(bin.resolvedFrom, path.join(shimDir, 'codex.cmd'));
    assert.equal(bin.prefixArgs.length, 1);
    assert.equal(bin.prefixArgs[0], entry);
    assert.notEqual(bin.cmd, bin.resolvedFrom, 'the .cmd shim must never be spawned directly');

    const agents = await (await request('/api/agents')).json();
    assert.equal(agents.codex, 'codex npm shim 1.2.3');
    assert.equal(agents.codexPath, path.join(shimDir, 'codex.cmd'));

    const events: unknown[] = [];
    const result = await codex.run({
      prompt: 'one turn',
      cwd: workDir,
      role: 'coder',
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.finalText, 'npm shim completed one turn');
    assert.equal(result.sessionId, 'shim-smoke');
    assert.ok(events.length > 0);

    const invalidShim = path.join(temp, 'bad shim', 'codex.cmd');
    await mkdir(path.dirname(invalidShim), { recursive: true });
    await writeFile(invalidShim, '@echo off\r\necho unsupported launcher\r\n');
    process.env.CODEX_BIN = invalidShim;
    const badShimInfo = await (await request('/api/agents')).json();
    assert.match(badShimInfo.codexError, /Only found shim codex\.cmd, set CODEX_BIN/);

    process.env.PATH = shimDir;
    delete process.env.CODEX_BIN;
    const electronFallback = resolveBin('codex');
    assert.equal(electronFallback.cmd, process.execPath);
    assert.equal(electronFallback.env?.ELECTRON_RUN_AS_NODE, '1');
    const fallbackRun = await codex.run({
      prompt: 'fallback turn',
      cwd: workDir,
      role: 'coder',
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    assert.equal(fallbackRun.finalText, 'npm shim completed one turn');

    // Like the npm shim itself, a node.exe next to the shim wins over PATH and the Electron fallback.
    const siblingNode = path.join(shimDir, 'node.exe');
    await writeFile(siblingNode, '');
    const withSibling = resolveBin('codex');
    assert.equal(withSibling.cmd, siblingNode);
    assert.equal(withSibling.env, undefined);
    await rm(siblingNode);
  } else {
    console.log('Skipping Windows .cmd shim launch checks on this platform.');
  }

  console.log('PASS npm shim resolution, reload discovery, and model validation');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await server.close();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = originalCodexBin;
  if (originalClaudeBin === undefined) delete process.env.CLAUDE_BIN;
  else process.env.CLAUDE_BIN = originalClaudeBin;
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.AI_DUO_DATA_DIR;
  delete process.env.AI_DUO_DEFAULT_CWD;
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);
}
