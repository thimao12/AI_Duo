/**
 * CLI smoke test.
 *   pnpm --filter ai-duo-cli test     (builds dist/ first)
 *
 * 1. The built bundle, copied outside the repository and run through pipes (no TTY) against fake
 *    `claude` / `codex` executables: prompt seeding, doctor, preflight, decision policies, --json,
 *    runs/show/continue, the repository lock and `unlock`, and exit codes.
 * 2. main() in-process with a fake terminal: interactive Plan and Code decisions, stdin closing
 *    during a prompt, and Ctrl+C.
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { findExecutable } from '../../shared/exe.ts';

const here = import.meta.dirname;
const dist = path.resolve(here, '../dist');
if (!existsSync(path.join(dist, 'ai-duo.mjs'))) throw new Error('cli/dist is missing: run `pnpm --filter ai-duo-cli build` first');

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo cli smoke '));
const install = path.join(temp, 'installed cli');
const bins = path.join(temp, 'fake bins');
const repo = path.join(temp, 'my repo');
const plain = path.join(temp, 'plain folder');
const dataDir = path.join(temp, 'data', 'runs');
const promptsDir = path.join(temp, 'data', 'prompts');
const log = path.join(temp, 'agent-calls.log');
await Promise.all([mkdir(bins), mkdir(repo), mkdir(plain), mkdir(promptsDir, { recursive: true })]);
await cp(dist, install, { recursive: true });
const git = findExecutable('git');
if (!git) throw new Error('git was not found in PATH');
execFileSync(git, ['init', '-q'], { cwd: repo });
await writeFile(path.join(repo, 'README.md'), 'fixture\n');
// A prompt the user customised must survive seeding.
await writeFile(path.join(promptsDir, 'fix.md'), 'CUSTOM FIX PROMPT {{review}}\n');

/** One fake CLI per agent: version, login status, the router's Haiku call, and agent turns. */
const fakeAgent = (agent: 'claude' | 'codex') => `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const AGENT = '${agent}';
const args = process.argv.slice(2);
const env = process.env;
const auth = env['FAKE_' + AGENT.toUpperCase() + '_AUTH'] || 'ok';
if (args.includes('--version')) { console.log(AGENT === 'claude' ? '9.9.9 (Fake Claude)' : 'codex-cli 9.9.9-fake'); process.exit(0); }
if (AGENT === 'claude' && args[0] === 'auth') {
  if (auth === 'unknown') { console.error("error: unknown command 'auth'"); process.exit(1); }
  console.log(JSON.stringify({ loggedIn: auth === 'ok', authMethod: 'claude.ai', apiProvider: 'firstParty' }));
  process.exit(0);
}
if (AGENT === 'codex' && args[0] === 'login') {
  if (auth === 'unknown') { console.error("error: unrecognized subcommand 'status'"); process.exit(2); }
  console.log(auth === 'ok' ? 'Logged in using ChatGPT' : 'Not logged in');
  process.exit(0);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (prompt += c));
process.stdin.on('end', () => {
  if (AGENT === 'claude' && args.includes('json') && !args.includes('stream-json')) {
    // Router classification (Haiku).
    console.log(JSON.stringify({ type: 'result', result: '\`\`\`json\\n{"taskType":"edit","complexity":"light"}\\n\`\`\`', usage: { input_tokens: 1, output_tokens: 1 } }));
    return;
  }
  const writable = AGENT === 'claude' ? args.includes('acceptEdits') || args.includes('Bash,Read,Grep,Glob') : !args.some((a) => a.includes('read-only'));
  const role = prompt.includes('You are the REVIEWER') ? 'reviewer' : writable ? 'coder' : 'thinker';
  fs.appendFileSync(env.FAKE_LOG, AGENT + ' ' + role + '\\n');
  if (env.FAKE_HANG) return void setInterval(() => {}, 1000);
  let reply;
  if (prompt.includes('Review this proposed implementation plan')) reply = 'Looks complete. PLAN_VERDICT: APPROVE';
  else if (role === 'thinker') reply = 'PLAN: create output.txt, then check it exists.';
  else if (role === 'reviewer') reply = '\`\`\`json\\n' + JSON.stringify({ verdict: env.FAKE_REVIEW === 'changes' ? 'CHANGES_REQUESTED' : 'APPROVE', tests: 'pass', issues: [] }) + '\\n\`\`\`';
  else { fs.writeFileSync(path.join(process.cwd(), 'output.txt'), 'written by ' + AGENT + '\\n'); reply = 'Implemented: wrote output.txt'; }
  if (AGENT === 'claude') {
    console.log(JSON.stringify({ type: 'result', result: reply, session_id: 'claude-fake', usage: { input_tokens: 10, output_tokens: 5 } }));
  } else {
    const out = args[args.indexOf('-o') + 1];
    fs.writeFileSync(out, reply);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-fake' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
  }
});
`;

const binFor: Record<'claude' | 'codex', string> = { claude: '', codex: '' };
await Promise.all((['claude', 'codex'] as const).map(async (agent) => {
  const script = path.join(bins, `fake-${agent}.js`);
  await writeFile(script, fakeAgent(agent));
  if (process.platform === 'win32') {
    // npm-style shim: AI Duo runs the .js entry with Node, never through cmd.exe.
    binFor[agent] = path.join(bins, `${agent}.cmd`);
    await writeFile(binFor[agent], `"%~dp0%\\fake-${agent}.js" %*\r\n`);
  } else {
    await chmod(script, 0o755);
    binFor[agent] = script;
  }
}));

const baseEnv: NodeJS.ProcessEnv = { ...process.env, AI_DUO_ALLOWED_ROOTS: JSON.stringify([temp]), AI_DUO_DATA_DIR: dataDir, AI_DUO_PROMPTS_DIR: promptsDir, CLAUDE_BIN: binFor.claude, CODEX_BIN: binFor.codex, CODEX_HOME: path.join(temp, 'codex-home'), FAKE_LOG: log, NO_COLOR: '1' };
delete baseEnv.INIT_CWD;
delete baseEnv.npm_package_name;
delete baseEnv.FORCE_COLOR;

interface Result { code: number; stdout: string; stderr: string }
/** Run the installed bundle with piped stdio (so no TTY) from `cwd`. */
function cli(args: string[], { cwd = repo, env = {}, input = '' }: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(install, 'ai-duo.mjs'), ...args], { cwd, env: { ...baseEnv, ...env }, windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === 'number' ? err.code : -1;
      resolve({ code, stdout, stderr });
    });
    child.stdin!.end(input);
  });
}
const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const resetCalls = () => writeFile(log, '');
/** Poll until `done()` holds, at most `tries` times; recursion keeps the waits strictly sequential. */
async function waitFor(done: () => boolean | Promise<boolean>, tries: number, ms: number): Promise<void> {
  if (tries <= 0 || (await done())) return;
  await new Promise((r) => setTimeout(r, ms));
  return waitFor(done, tries - 1, ms);
}
const show = (r: Result) => `exit ${r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;

let failed = false;
try {
  // ---- Bundle outside the repository: help, doctor, prompt seeding.
  const help = await cli(['--help'], { cwd: temp });
  assert.equal(help.code, 0, show(help));
  assert.match(help.stdout, /ai-duo run/);
  const doctor = await cli(['doctor']);
  assert.equal(doctor.code, 0, show(doctor));
  assert.match(doctor.stdout, /Fake Claude/);
  assert.match(doctor.stdout, /codex-cli 9\.9\.9-fake/);
  const seeded = (await readdir(promptsDir)).filter((name) => name.endsWith('.md')).sort();
  assert.deepEqual(seeded, ['code.md', 'critique.md', 'fix.md', 'propose.md', 'review.md', 'route.md', 'synthesize.md']);
  assert.equal(await readFile(path.join(promptsDir, 'fix.md'), 'utf8'), 'CUSTOM FIX PROMPT {{review}}\n', 'seeding never overwrites an edited prompt');
  assert.equal((await cli(['bogus'])).code, 2);
  assert.equal((await cli(['run'])).code, 2, 'a request is required');
  assert.equal((await cli(['run', 'x', '--plan-decision', 'refine'])).code, 2, 'refine needs a terminal');

  // Roots are fixed at startup. An explicit cwd cannot expand them or start any agent.
  await resetCalls();
  const deniedRuns = await Promise.all([
    ['run', 'Implement a change', '--cwd', plain],
    ['doctor', '--cwd', plain],
    ['unlock', plain],
  ].map((args) => cli(args, { env: { AI_DUO_ALLOWED_ROOTS: JSON.stringify([repo]) } })));
  for (const denied of deniedRuns) {
    assert.equal(denied.code, 2, show(denied));
    assert.match(denied.stderr, /outside AI_DUO_ALLOWED_ROOTS/);
  }
  assert.equal((await calls()).length, 0);
  const badRoots = await cli(['--help'], { env: { AI_DUO_ALLOWED_ROOTS: '["relative"]' } });
  assert.notEqual(badRoots.code, 0, 'invalid root configuration prevents startup');
  assert.match(badRoots.stderr, /AI_DUO_ALLOWED_ROOTS/);

  // ---- Preflight: missing login stops at once; an unverifiable login needs --skip-auth-check.
  await resetCalls();
  const noLogin = await cli(['run', 'Implement and add a small change.', '--mode', 'plan'], { env: { FAKE_CODEX_AUTH: 'none', FAKE_CLAUDE_AUTH: 'none' } });
  assert.equal(noLogin.code, 3, show(noLogin));
  assert.match(noLogin.stderr, /chưa đăng nhập/);
  const unknown = await cli(['run', 'Implement and add a small change.', '--mode', 'plan'], { env: { FAKE_CODEX_AUTH: 'unknown', FAKE_CLAUDE_AUTH: 'unknown' } });
  assert.equal(unknown.code, 3, show(unknown));
  assert.match(unknown.stderr, /--skip-auth-check/);
  assert.equal((await calls()).length, 0, 'preflight failures never start an agent turn');
  const skipped = await cli(['run', 'Implement and add a small change.', '--mode', 'plan', '--skip-auth-check'], { env: { FAKE_CODEX_AUTH: 'unknown', FAKE_CLAUDE_AUTH: 'unknown' } });
  assert.equal(skipped.code, 0, show(skipped));
  const codeInPlain = await cli(['run', 'Implement and add a small change.', '--cwd', plain]);
  assert.equal(codeInPlain.code, 2, 'Code needs Git');
  assert.match(codeInPlain.stderr, /git repository/);
  await resetCalls();
  const approveInPlain = await cli(['run', 'Implement and add a small change.', '--mode', 'plan', '--plan-decision=approve', '--cwd', plain]);
  assert.equal(approveInPlain.code, 2, `approving into Code outside Git is refused up front: ${show(approveInPlain)}`);
  assert.match(approveInPlain.stderr, /git init.*drop --plan-decision=approve/s);
  assert.equal((await calls()).length, 0, 'nothing ran');

  // ---- No TTY: a Plan decision stops by default; progress on stderr, the plan on stdout.
  await resetCalls();
  const planStop = await cli(['run', 'Implement and add a small change.', '--mode', 'plan']);
  assert.equal(planStop.code, 0, show(planStop));
  assert.match(planStop.stdout, /PLAN: create output\.txt/);
  assert.doesNotMatch(planStop.stdout, /Routing|✓ done/, 'stdout carries only the result');
  assert.match(planStop.stderr, /Plan decision: stop/);
  assert.equal(existsSync(path.join(repo, 'output.txt')), false, 'stopping never runs Code');
  assert.ok((await calls()).every((c) => c.endsWith('thinker')));

  // ---- --plan-decision=approve runs Code in the same run; --json is machine readable.
  const approved = await cli(['run', 'Implement and add a small change.', '--mode', 'plan', '--plan-decision=approve', '--json']);
  assert.equal(approved.code, 0, show(approved));
  const result = JSON.parse(approved.stdout);
  assert.equal(result.status, 'done');
  assert.equal(result.mode, 'code');
  assert.match(result.diff, /output\.txt/);
  assert.ok(existsSync(path.join(repo, 'output.txt')));
  await rm(path.join(repo, 'output.txt'));

  // ---- Code review limit: stop by default; --pair-extra-rounds=N grants blocks of 2 within N.
  for (const [flags, reviews] of [[[], 2], [['--pair-extra-rounds', '3'], 4], [['--pair-extra-rounds=4'], 6]] as const) {
    await resetCalls();
    const limited = await cli(['run', 'Implement and add a small change.', ...flags], { env: { FAKE_REVIEW: 'changes' } });
    assert.equal(limited.code, 0, show(limited));
    assert.equal((await calls()).filter((c) => c.endsWith('reviewer')).length, reviews, `${flags.join(' ') || 'default'}: ${show(limited)}`);
    assert.match(limited.stderr, /Review limit reached/);
  }

  // ---- History: runs, show, continue share the data folder.
  const list = await cli(['runs', '--json']);
  assert.equal(list.code, 0, show(list));
  const runs = JSON.parse(list.stdout);
  assert.ok(runs.length >= 5);
  assert.ok(runs.every((r: { cwd: string }) => r.cwd.toLowerCase().startsWith(temp.toLowerCase())));
  assert.equal(JSON.parse((await cli(['runs', '--json'], { cwd: plain })).stdout).length, 0, 'runs is scoped to the current folder or repository');
  const shown = await cli(['show', result.id]);
  assert.equal(shown.code, 0, show(shown));
  assert.match(shown.stdout, /PLAN: create output\.txt/);
  assert.match((await cli(['show', result.id, '--diff'])).stdout, /output\.txt/);
  assert.equal((await cli(['show', 'no-such-run'])).code, 2);
  await resetCalls();
  const restrictedEnv = { AI_DUO_ALLOWED_ROOTS: JSON.stringify([plain]) };
  assert.equal((await cli(['show', result.id], { env: restrictedEnv })).code, 0, 'old runs outside roots remain readable');
  const deniedFollowUp = await cli(['continue', result.id, 'Continue', '--json'], { env: restrictedEnv });
  assert.equal(deniedFollowUp.code, 2, show(deniedFollowUp));
  assert.equal(JSON.parse(deniedFollowUp.stdout).code, 'invalid');
  assert.match(deniedFollowUp.stderr, /outside AI_DUO_ALLOWED_ROOTS/);
  assert.equal((await calls()).length, 0, 'denied follow-ups never start an agent');
  const followed = await cli(['continue', result.id, 'Also add a newline.', '--json']);
  assert.equal(followed.code, 0, show(followed));
  assert.equal(JSON.parse(followed.stdout).id, result.id);
  const thread = JSON.parse((await cli(['show', result.id, '--json'])).stdout);
  assert.ok(thread.messages.some((m: { agent: string; parts: { content: string }[] }) => m.agent === 'user' && m.parts[0].content === 'Also add a newline.'));

  // ---- Repository lock across processes: a second run is refused (exit 4) through another path;
  //      a killed process leaves its lock until `unlock` confirms the PID is gone.
  await mkdir(path.join(repo, 'nested'), { recursive: true });
  const hanging = spawn(process.execPath, [path.join(install, 'ai-duo.mjs'), 'run', 'Implement and add a small change.'], { cwd: repo, env: { ...baseEnv, FAKE_HANG: '1' }, stdio: 'ignore', windowsHide: true });
  const locks = path.join(dataDir, 'locks');
  await waitFor(async () => (await readdir(locks).catch(() => [])).some((f) => f.endsWith('.lock')), 300, 50);
  await waitFor(async () => (await calls()).length > 0, 300, 50);
  const blocked = await cli(['run', 'Implement and add a small change.', '--mode', 'plan', '--cwd', path.join(repo, 'nested')]);
  assert.equal(blocked.code, 4, show(blocked));
  assert.match(blocked.stderr, /already active for this repository/);
  const refused = await cli(['unlock']);
  assert.equal(refused.code, 4, 'a live owner is not unlocked');
  // Kill the CLI and its fake agent without letting it clean up.
  if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'taskkill.exe'), ['/PID', String(hanging.pid), '/T', '/F'], { stdio: 'ignore' });
  else hanging.kill('SIGKILL');
  await new Promise((r) => (hanging.exitCode !== null ? r(null) : hanging.once('exit', r)));
  const stale = await cli(['run', 'Implement and add a small change.']);
  assert.equal(stale.code, 4, show(stale));
  assert.match(stale.stderr, /ai-duo unlock/);
  const unlocked = await cli(['unlock', path.join(repo, 'nested')]);
  assert.equal(unlocked.code, 0, show(unlocked));
  assert.match(unlocked.stderr, /Unlocked/);
  const after = await cli(['run', 'Implement and add a small change.', '--mode', 'plan']);
  assert.equal(after.code, 0, show(after));
  console.log('PASS built CLI outside the repo: seeding, doctor, preflight, non-TTY decisions, --json, history, lock and unlock');
} catch (err) {
  console.error(err);
  failed = true;
}

// ---- In-process with a fake terminal.
if (!failed) {
  try {
    process.env.AI_DUO_DATA_DIR = dataDir;
    process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([temp]);
    process.env.AI_DUO_PROMPTS_DIR = promptsDir;
    process.env.CLAUDE_BIN = path.join(temp, 'missing-claude.exe');
    process.env.CODEX_BIN = path.join(temp, 'missing-codex.exe');
    await import('./env.ts');
    const [{ main }, { agents }, { AbortedError }, { lockTarget }] = await Promise.all([
      import('./commands.ts'),
      import('../../server/src/agents/index.ts'),
      import('../../server/src/agents/process.ts'),
      import('../../server/src/lock.ts'),
    ]);
    for (const agent of ['claude', 'codex'] as const) {
      agents[agent].check = () => Promise.resolve({ agent, path: agent, version: 'fake', auth: 'ok' });
    }
    let hang = false;
    let review = 'APPROVE';
    for (const agent of ['claude', 'codex'] as const) {
      agents[agent].run = async (o) => {
        if (hang) {
          return new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(new AbortedError()), { once: true }));
        }
        if (o.prompt.includes('Review this proposed implementation plan')) return { finalText: 'PLAN_VERDICT: APPROVE' };
        if (o.role === 'thinker') return { finalText: o.prompt.includes('Revise') ? 'Revised plan with tests.' : 'First plan.' };
        if (o.role === 'reviewer') return { finalText: `\`\`\`json\n{"verdict":"${review}","tests":"pass","issues":[]}\n\`\`\`` };
        await writeFile(path.join(o.cwd, 'tty-output.txt'), 'x\n');
        return { finalText: 'Implemented.' };
      };
    }

    /** A terminal: stdin reports isTTY; answers are typed whenever a prompt appears. */
    function terminal(answers: (string | null)[]) {
      const stdin = Object.assign(new PassThrough(), { isTTY: true });
      const stdout = new PassThrough();
      const stderr = Object.assign(new PassThrough(), { isTTY: false });
      let out = '';
      let err = '';
      let interrupt: (() => void) | undefined;
      stdout.on('data', (c) => (out += c));
      let answered = 0;
      stderr.on('data', (c) => {
        err += c;
        // Every prompt ends with "› "; answer each new one (null closes stdin, like Ctrl+D).
        const prompts = err.split('› ').length - 1;
        while (answered < prompts && answers.length) {
          answered++;
          const next = answers.shift()!;
          setTimeout(() => (next === null ? stdin.end() : stdin.write(`${next}\n`)), 10);
        }
      });
      const io = { stdin, stdout, stderr, env: { NO_COLOR: '1' }, cwd: repo, onInterrupt: (fn: () => void) => {
        interrupt = fn;
        return () => { interrupt = undefined; };
      } };
      return { io, out: () => out, err: () => err, interrupt: () => interrupt?.() };
    }

    // Plan: an unknown answer asks again, refine sends feedback, approve implements.
    const t1 = terminal(['maybe', 'r', 'Add tests too.', 'a']);
    assert.equal(await main(['run', 'Implement and add a small change.', '--mode', 'plan'], t1.io), 0, t1.err());
    assert.match(t1.err(), /Plan ready \(revision 0/);
    assert.match(t1.err(), /Plan ready \(revision 1/);
    assert.match(t1.out(), /Implemented\.|approve/);
    assert.ok(existsSync(path.join(repo, 'tty-output.txt')));

    // Outside Git, approve is marked unavailable; choosing it anyway explains why and asks again.
    const tPlain = terminal(['a', 's']);
    assert.equal(await main(['run', 'Implement and add a small change.', '--mode', 'plan', '--cwd', plain], tPlain.io), 0, tPlain.err());
    assert.match(tPlain.err(), /Approve is unavailable: .*git init/);
    assert.match(tPlain.err(), /The plan is still waiting/);
    assert.equal((tPlain.err().match(/› /g) ?? []).length, 2, 'asked again after the refused approval');
    assert.equal(existsSync(path.join(plain, 'tty-output.txt')), false);

    // Code: continue once at the review limit, then stop.
    review = 'CHANGES_REQUESTED';
    const t2 = terminal(['c', 's']);
    assert.equal(await main(['run', 'Implement and add a small change.'], t2.io), 0, t2.err());
    assert.equal((t2.err().match(/Not approved after round/g) ?? []).length, 2);

    // stdin closes while a decision is asked: stop cleanly.
    review = 'APPROVE';
    const t3 = terminal([null]);
    assert.equal(await main(['run', 'Implement and add a small change.', '--mode', 'plan'], t3.io), 0, t3.err());
    assert.match(t3.err(), /stdin closed; cannot collect decision/);

    // Ctrl+C: agents are stopped, the run is saved as cancelled, the lock is released, exit 130.
    hang = true;
    const t4 = terminal([]);
    const running = main(['run', 'Implement and add a small change.', '--json'], t4.io);
    await waitFor(() => /Run \S+ ·/.test(t4.err()), 200, 25);
    await new Promise((r) => setTimeout(r, 100));
    t4.interrupt();
    assert.equal(await running, 130, t4.err());
    assert.equal(JSON.parse(t4.out()).status, 'cancelled');
    assert.equal(existsSync((await lockTarget(repo)).file), false, 'Ctrl+C releases the lock');
    console.log('PASS interactive Plan/Code decisions, stdin closed during a prompt, and Ctrl+C');
  } catch (err) {
    console.error(err);
    failed = true;
  }
}

await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);
process.exit(failed ? 1 : 0);
