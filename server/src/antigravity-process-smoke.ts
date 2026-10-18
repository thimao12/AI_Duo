/**
 * Antigravity adapter against a fake `agy` (no real CLI, no model call).
 *   pnpm --filter server test
 *
 * Checks the argv and the stream-json message on stdin, that stdin is closed (EOF ends the turn), that
 * images are refused before anything is spawned, and how a non-zero exit after SUCCESS, a stream without
 * result, non-JSON output, soft tool denials on stderr, an agy without --mode, a timeout and a cancel end.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A folder with spaces, as under a Windows user profile.
const temp = await mkdtemp(path.join(tmpdir(), 'ai duo agy process '));
const repo = path.join(temp, 'work dir');
await mkdir(repo);
process.env.AI_DUO_SETTINGS_FILE = path.join(temp, 'settings.json');
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
const logFile = path.join(temp, 'agy-log.json');

const script = path.join(temp, 'fake-agy.js');
await writeFile(
  script,
  `#!/usr/bin/env node
const fs = require('node:fs');
const mode = process.env.FAKE_AGY_MODE || 'ok';
const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2), stdin: input, cwd: process.cwd() }));
  if (mode === 'hang') return setInterval(() => {}, 1000);
  if (mode === 'old') { process.stderr.write('error: unknown flag: --mode\\n'); process.exit(1); }
  out({ event: 'init', conversation_id: 'conv-top', init: { conversation_id: 'conv-nested' } });
  if (mode === 'no-result') return;
  if (mode === 'garbage') { process.stdout.write('this is not json\\n'); return; }
  out({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: mode === 'denied' ? '' : 'pong' } });
  if (mode === 'denied') process.stderr.write('Tool run_command was denied: requires approval\\n');
  out({ event: 'result', result: { status: 'SUCCESS', response: mode === 'denied' ? '' : 'pong', usage: { input_tokens: 3, output_tokens: 1 } } });
  if (mode === 'crash') { process.stderr.write('late crash\\n'); process.exit(2); }
});
`,
  'utf8',
);
if (process.platform === 'win32') {
  // An npm-style shim: the adapter starts node with the JS entry, as for an installed agy.cmd.
  const shim = path.join(temp, 'agy.cmd');
  await writeFile(shim, `@ECHO off\r\nnode "%~dp0\\fake-agy.js" %*\r\n`, 'utf8');
  process.env.AGY_BIN = shim;
} else {
  await chmod(script, 0o755);
  process.env.AGY_BIN = script;
}

const { antigravity, AGY_IMAGES_UNSUPPORTED } = await import('./agents/antigravity.ts');
const { AbortedError } = await import('./agents/process.ts');
type AgentEvent = import('./agents/types.ts').AgentEvent;
type RunOptions = import('./agents/types.ts').RunOptions;

const readLog = async () => JSON.parse(await readFile(logFile, 'utf8')) as { argv: string[]; stdin: string; cwd: string };
const run = (mode: string, over: Partial<RunOptions> = {}) => {
  process.env.FAKE_AGY_MODE = mode;
  const events: AgentEvent[] = [];
  const result = antigravity.run({ prompt: 'ping "quoted" & | <x>', cwd: repo, role: 'thinker', signal: new AbortController().signal, allowUnverifiedAuth: true, onEvent: (e) => events.push(e), ...over });
  return { result, events };
};

let failed = false;
const step = async (name: string, fn: () => Promise<void>) => {
  try {
    await rm(logFile, { force: true });
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${name}\n${(err as Error).stack}`);
  }
};

await step('read turn: --mode plan, stream-json both ways, prompt on stdin as one JSON line, closed', async () => {
  const { result, events } = run('ok', { model: 'gemini-x' });
  const out = await result;
  assert.equal(out.finalText, 'pong');
  assert.equal(out.sessionId, 'conv-top', 'the documented top-level id');
  assert.deepEqual(out.usage, { inputTokens: 3, outputTokens: 1, cachedInputTokens: 0 });
  const log = await readLog();
  assert.deepEqual(log.argv, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '--model', 'gemini-x', '-p=']);
  assert.equal(log.stdin, JSON.stringify({ event: 'user', message: { content: 'ping "quoted" & | <x>' } }) + '\n', 'the prompt is never on the command line');
  assert.equal(path.resolve(log.cwd).toLowerCase(), path.resolve(repo).toLowerCase());
  assert.ok(events.some((e) => e.kind === 'text_delta' && e.content === 'pong'));
});

await step('edit turn resumes the conversation with --mode accept-edits', async () => {
  await run('ok', { role: 'coder', sessionId: 'conv-1' }).result;
  assert.deepEqual((await readLog()).argv, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'accept-edits', '--conversation', 'conv-1', '-p=']);
});

await step('images are refused before agy is started', async () => {
  await assert.rejects(run('ok', { images: [path.join(temp, 'a.png')] }).result, (err: Error) => err.message === AGY_IMAGES_UNSUPPORTED);
  await assert.rejects(readFile(logFile), 'nothing was spawned');
});

await step('a non-zero exit fails even after SUCCESS', async () => {
  await assert.rejects(run('crash').result, /exited with code 2 after its result: late crash/);
});

await step('a stream that ends without result fails; so does output that is not stream-json', async () => {
  await assert.rejects(run('no-result').result, /không gửi kết quả/);
  const garbage = run('garbage');
  await assert.rejects(garbage.result, /không gửi kết quả/);
  assert.ok(garbage.events.some((e) => e.kind === 'raw' && e.content === 'this is not json'), 'the line is shown as-is');
});

await step('soft denial on stderr: the turn ends, the denial is reported, no advice to skip permission checks', async () => {
  const { result, events } = run('denied');
  const out = await result;
  assert.match(out.finalText, /run_command was denied/);
  assert.doesNotMatch(out.finalText, /dangerously/);
  assert.ok(events.some((e) => e.kind === 'error' && /run_command was denied/.test(e.content)));
});

await step('an agy without --mode is reported as incompatible', async () => {
  await assert.rejects(run('old').result, /không nhận chế độ headless.*--mode plan/);
});

await step('timeout and cancel stop the process', async () => {
  await assert.rejects(run('hang', { timeoutMs: 1500 }).result, /timed out/);
  const controller = new AbortController();
  const cancelled = run('hang', { signal: controller.signal });
  setTimeout(() => controller.abort(), 800);
  await assert.rejects(cancelled.result, (err: Error) => err instanceof AbortedError);
});

await rm(temp, { recursive: true, force: true }).catch(() => {});
if (failed) {
  console.error('antigravity process smoke test failed');
  process.exit(1);
}
console.log('PASS antigravity process: argv, stdin, images, exit codes, missing result, denials, old agy, timeout, cancel');
process.exit(0);
