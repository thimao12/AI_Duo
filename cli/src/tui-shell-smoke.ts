/**
 * Shell mode smoke test.
 *   pnpm --filter ai-duo-cli exec tsx src/tui-shell-smoke.ts
 *
 * Unit tests of the runner (shell selection, output sanitising and caps) and ink-testing-library tests
 * of the composer's shell mode: ! at the start of an empty box, Esc / Backspace to leave, running a real
 * command, stderr and exit footers, progress lines, ANSI stripping, Ctrl+C killing a process tree
 * without quitting, refusal while a run is active, and history entries with a leading !.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import type { RunHandle, RunRequest, StartOptions } from '../../server/src/service.ts';
import type { Run } from '../../server/src/types.ts';

const temp = await mkdtemp(path.join(tmpdir(), 'aiduoshell-'));
process.env.NO_COLOR = '1';
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
process.env.AI_DUO_SETTINGS_FILE = path.join(temp, 'settings.json');
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([temp]);

// Loaded after the environment is set: the server modules read it when they load.
const { render, cleanup } = await import('ink-testing-library');
const { App } = await import('./tui/App.tsx');
const { SHELL_HINT } = await import('./tui/Composer.tsx');
const { loadHistory } = await import('./tui/history.ts');
const shell = await import('./tui/shell.ts');
type ChatService = import('./tui/useSession.ts').ChatService;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(done: () => boolean, what: string, tries = 400): Promise<void> {
  if (done()) return;
  if (tries <= 0) throw new Error(`timed out waiting for ${what}`);
  await sleep(20);
  return until(done, what, tries - 1);
}

const KEY = { enter: '\r', esc: '\u001B', up: '\u001B[A', down: '\u001B[B', backspace: '\u007F', ctrlC: '\u0003', ctrlU: '\u0015' };
const PASTE_START = '\u001B[200~';
const PASTE_END = '\u001B[201~';
const ESC_CHAR = String.fromCodePoint(27);

/* ---- Helper scripts, run by the real shell ---- */

const SCRIPTS: Record<string, string> = {
  'hi.js': "console.log('hi from shell');",
  'mixed.js': "console.log('to-out'); console.error('to-err'); process.exitCode = 3;",
  'progress.js': String.raw`process.stdout.write('progress 10%\rprogress 50%\rprogress 100%\ndone\n');`,
  'ansi.js': String.raw`process.stdout.write('\x1b[31mred\x1b[0m \x1b]0;window-title\x07plain\x1b[2K\n');`,
  'flood.js': "for (let i = 0; i < 3000; i++) console.log('line ' + i);",
  'child.js': 'setInterval(() => {}, 1000);',
  'long.js': [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const child = spawn(process.execPath, [path.join(__dirname, 'child.js')], { stdio: 'ignore' });",
    "fs.writeFileSync(path.join(__dirname, 'pids.txt'), process.pid + ',' + child.pid);",
    "console.log('spawned-ok');",
    'setInterval(() => {}, 1000);',
  ].join('\n'),
};
for (const [name, body] of Object.entries(SCRIPTS)) await writeFile(path.join(temp, name), body);

/** The command text that runs `node <script>` in whichever shell the runner picked (absolute node path). */
function nodeCommand(script: string): string {
  const file = path.join(temp, script);
  switch (shell.selectShell().name) {
    case 'cmd':
      return `"${process.execPath}" "${file}"`;
    case 'posix':
      return `'${process.execPath}' '${file}'`;
    default:
      return `& '${process.execPath}' '${file}'`;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/* ---- Fake service: a run that stays active until it is cancelled ---- */

class HangService {
  starts = 0;
  cancels = 0;
  start = async (request: RunRequest, options: StartOptions = {}): Promise<RunHandle> => {
    this.starts++;
    const run: Run = {
      id: `run-${this.starts}`,
      config: { mode: 'code', prompt: request.prompt ?? '', cwd: request.cwd ?? temp, maxRounds: 2, judge: 'claude', coder: 'claude', turnTimeoutMin: 30 },
      status: 'running',
      createdAt: Date.now(),
      messages: [],
    };
    options.onCreated?.(structuredClone(run));
    let finish: () => void = () => {};
    const done = new Promise<Run>((resolve) => {
      finish = () => resolve({ ...run, status: 'cancelled', endedAt: Date.now() });
    });
    return {
      id: run.id,
      get run() {
        return run;
      },
      subscribe: () => () => {},
      done,
      cancel: () => {
        this.cancels++;
        finish();
      },
      answerPlanDecision: async () => {},
      answerPairDecision: () => true,
    };
  };
  continue = async (_id: string, request: RunRequest, options: StartOptions = {}): Promise<RunHandle> => this.start(request, options);
  get = async () => undefined;
  preflight = async () => ({ ok: true, checks: [], problems: [], authUnverified: false });
  previewRoute = async () => ({ mode: 'code' as const, coder: 'codex' as const, reviewer: 'claude' as const, maxRounds: 2, route: {} as never, askHaiku: false });
  abortAll = async () => {};
}

interface OpenOptions {
  history?: string[];
  historyFile?: string;
  screen?: 'fullscreen' | 'inline';
}

function open({ history = [], historyFile, screen = 'inline' }: OpenOptions = {}) {
  const service = new HangService();
  const app = render(createElement(App, { service: service as unknown as ChatService, cwd: temp, version: 'test', history, historyFile, skipPreflight: true, screen }));
  const frame = () => app.lastFrame() ?? '';
  const type = async (text: string) => {
    app.stdin.write(text);
    await sleep(30);
  };
  const seeing = (text: string | RegExp, tries?: number) => until(() => (typeof text === 'string' ? frame().includes(text) : text.test(frame())), `"${String(text)}"\n${frame()}`, tries);
  const notSeeing = (text: string) => assert.ok(!frame().includes(text), `unexpected "${text}"\n${frame()}`);
  return { app, service, frame, type, seeing, notSeeing };
}

let failed = false;
const step = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${name}\n${(err as Error).stack}`);
  } finally {
    cleanup();
  }
};

/* ---- Runner: shell selection ---- */

await step('selectShell: Windows prefers PowerShell found on PATH, then the built-in one, then cmd.exe (absolute paths only)', async () => {
  const env = { SystemRoot: String.raw`C:\Windows`, ComSpec: String.raw`C:\Windows\System32\cmd.exe` };
  const pwshPath = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`;
  const pwsh = shell.selectShell({ platform: 'win32', env, find: (n) => (n === 'pwsh' ? pwshPath : undefined), canRun: () => true });
  assert.equal(pwsh.name, 'pwsh');
  assert.equal(pwsh.file, pwshPath);
  assert.deepEqual(pwsh.args('dir').slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.ok(pwsh.args('dir')[4].includes('dir'));
  assert.equal(pwsh.verbatim, false);
  const found = shell.selectShell({ platform: 'win32', env, find: (n) => (n === 'powershell' ? String.raw`C:\x\powershell.exe` : undefined), canRun: () => true });
  assert.equal(found.name, 'powershell');
  const builtin = shell.selectShell({ platform: 'win32', env, find: () => undefined, canRun: () => true });
  assert.equal(builtin.file, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  const cmd = shell.selectShell({ platform: 'win32', env, find: () => undefined, canRun: () => false });
  assert.equal(cmd.name, 'cmd');
  assert.equal(cmd.file, String.raw`C:\Windows\System32\cmd.exe`);
  assert.deepEqual(cmd.args('echo hi'), ['/d', '/s', '/c', '"echo hi"']);
  assert.equal(cmd.verbatim, true);
  const relative = shell.selectShell({ platform: 'win32', env: { SystemRoot: String.raw`C:\Windows`, ComSpec: 'cmd.exe' }, find: () => undefined, canRun: () => false });
  assert.equal(relative.file, String.raw`C:\Windows\System32\cmd.exe`, 'a relative ComSpec is not used');
});

await step('selectShell: POSIX uses an absolute executable $SHELL, else /bin/sh', async () => {
  const posix = (SHELL: string | undefined, canRun: boolean) => shell.selectShell({ platform: 'linux', env: { SHELL }, find: () => undefined, canRun: () => canRun });
  assert.equal(posix('/usr/bin/zsh', true).file, '/usr/bin/zsh');
  assert.deepEqual(posix('/usr/bin/zsh', true).args('ls'), ['-c', 'ls']);
  assert.equal(posix('zsh', true).file, '/bin/sh', 'relative $SHELL is ignored');
  assert.equal(posix('/usr/bin/zsh', false).file, '/bin/sh', 'a $SHELL that is not executable is ignored');
  assert.equal(posix(undefined, true).file, '/bin/sh');
  assert.ok(path.isAbsolute(shell.selectShell().file), 'the real selection is an absolute path');
});

/* ---- Runner: sanitising ---- */

await step('Scrubber: ANSI and OSC removed (also split across chunks), control chars dropped, bad UTF-8 tolerated', async () => {
  const s = new shell.Scrubber();
  assert.equal(s.feed(`${ESC_CHAR}[31mred${ESC_CHAR}[0m ok`), 'red ok');
  assert.equal(s.feed(`a${ESC_CHAR}]0;title\u0007b`), 'ab', 'OSC ended by BEL');
  assert.equal(s.feed(`a${ESC_CHAR}]8;;http://x${ESC_CHAR}\\link${ESC_CHAR}]8;;${ESC_CHAR}\\b`), 'alinkb', 'OSC ended by ST');
  assert.equal(s.feed(`x${ESC_CHAR}[3`) + s.feed('1;1Hy'), 'xy', 'a sequence split across chunks');
  assert.equal(s.feed('a\u0000b\u0007c\u0008d\u007Fe\u009Bf'), 'abcdef', 'control characters dropped');
  assert.equal(s.feed('a\tb\r\nc'), 'a\tb\r\nc', 'tab, CR and LF are kept for the line builder');
  assert.equal(s.feed(Buffer.from([0xff, 0x41, 0xc3])) + s.feed(Buffer.from([0xa9])), '\uFFFDAé', 'invalid UTF-8 and a split character');
  assert.equal(s.feed(`${ESC_CHAR}(Bz`), 'z', 'charset escape');
});

await step('ShellOutput: CR overwrites, tabs expand, CRLF, stream switches, unfinished line is shown', async () => {
  const o = new shell.ShellOutput();
  o.push('out', 'abc\r\nprogress 10%\rprogress 50%\rprogress 100%\r\ndone\n');
  assert.deepEqual(o.lines().map((l) => l.text), ['abc', 'progress 100%', 'done']);
  const p = new shell.ShellOutput();
  p.push('out', 'one\ttwo\n');
  p.push('out', 'half');
  assert.deepEqual(p.lines().map((l) => l.text), ['one     two', 'half'], 'tab to the next 8-column stop; unfinished line visible');
  p.push('err', 'bad\n');
  assert.deepEqual(p.lines().map((l) => [l.text, l.stream]), [['one     two', 'out'], ['half', 'out'], ['bad', 'err']], 'a stream switch ends the unfinished line');
  const q = new shell.ShellOutput();
  q.push('out', 'blank\n\nafter');
  q.end();
  assert.deepEqual(q.lines().map((l) => l.text), ['blank', '', 'after']);
});

await step('ShellOutput: output is capped (head + tail with an omitted marker); a huge single line is clipped', async () => {
  const o = new shell.ShellOutput();
  for (let i = 0; i < 20_000; i++) o.push('out', `line ${i}\n`);
  o.end();
  const lines = o.lines();
  assert.ok(lines.length <= shell.MAX_LINES + 1, `kept ${lines.length}`);
  assert.equal(lines[0].text, 'line 0', 'the head is kept');
  assert.equal(lines.at(-1)?.text, 'line 19999', 'the tail is kept');
  const marker = lines.find((l) => l.stream === 'note');
  assert.ok(marker);
  assert.equal(marker.text, `… ${20_000 - (lines.length - 1)} lines omitted …`);
  const big = new shell.ShellOutput();
  for (let i = 0; i < 400; i++) big.push('out', 'x'.repeat(10_000));
  big.end();
  assert.equal(big.lines().length, 1);
  assert.ok(big.lines()[0].text.length <= shell.LINE_MAX + 1, 'a line without a newline is clipped');
  const wide = new shell.ShellOutput();
  for (let i = 0; i < 3000; i++) wide.push('out', `${'y'.repeat(900)}\n`);
  wide.end();
  const total = wide.lines().reduce((n, l) => n + l.text.length + 1, 0);
  assert.ok(total <= shell.MAX_BYTES + 1000, `kept ${total} characters`);
});

await step('isDirectoryChange and inputHint', async () => {
  for (const yes of ['cd ..', '  cd', String.raw`cd /d C:\x`, 'pushd x', 'Set-Location ..', 'sl x']) assert.ok(shell.isDirectoryChange(yes), yes);
  for (const no of ['echo cd', 'cdr x', 'ls', 'node cd.js']) assert.ok(!shell.isDirectoryChange(no), no);
  assert.ok(shell.inputHint([{ text: 'Error: stdin is not a TTY', stream: 'err' }]));
  assert.equal(shell.inputHint([{ text: 'fine', stream: 'out' }]), undefined);
});

/* ---- Runner: real processes ---- */

await step('runShell: runs a real command in the cwd, merges stdout and stderr, reports the exit code', async () => {
  const hi = await shell.runShell(nodeCommand('hi.js'), { cwd: temp }).done;
  assert.equal(hi.state, 'exited');
  assert.equal(hi.code, 0);
  assert.deepEqual(hi.lines, [{ text: 'hi from shell', stream: 'out' }]);
  const bad = await shell.runShell(nodeCommand('mixed.js'), { cwd: temp }).done;
  assert.equal(bad.code, 3);
  assert.deepEqual(bad.lines.map((l) => `${l.stream}:${l.text}`).sort((a, b) => a.localeCompare(b)), ['err:to-err', 'out:to-out']);
});

await step('runShell: a missing folder fails to start; the timeout and kill() end a long command', async () => {
  const missing = await shell.runShell(nodeCommand('hi.js'), { cwd: path.join(temp, 'no such folder') }).done;
  assert.equal(missing.state, 'failed');
  assert.ok(missing.error);
  const timed = await shell.runShell(nodeCommand('long.js'), { cwd: temp, timeoutMs: 1500 }).done;
  assert.equal(timed.state, 'timeout');
  const handle = shell.runShell(nodeCommand('long.js'), { cwd: temp });
  await sleep(1200);
  handle.kill();
  assert.equal((await handle.done).state, 'interrupted');
});

/* ---- Composer: entering and leaving shell mode ---- */

await step('! as the first character enters shell mode; Esc and Backspace on empty leave it', async () => {
  const t = open();
  await t.seeing('Ask anything');
  await t.type('!');
  await t.seeing(SHELL_HINT);
  t.notSeeing('Ask anything');
  assert.match(t.frame(), /│ ! /, 'prompt glyph is !');
  assert.ok(!t.frame().includes('│ !!'), 'the typed ! is consumed');
  await t.type('ab');
  await t.seeing('ab');
  await t.type(KEY.backspace);
  await t.type(KEY.backspace);
  await t.seeing(SHELL_HINT);
  await t.type(KEY.backspace);
  await t.seeing('Ask anything');
  t.notSeeing(SHELL_HINT);
  await t.type('!');
  await t.type('dir');
  await t.seeing('dir');
  await t.type(KEY.esc);
  await t.seeing('Ask anything');
  t.notSeeing(SHELL_HINT);
});

await step('! in the middle of text, or after a space, does not enter shell mode', async () => {
  const t = open();
  await t.type('echo hi!');
  await t.seeing('echo hi!');
  t.notSeeing(SHELL_HINT);
  await t.type(KEY.ctrlU);
  await t.type(' !');
  await t.seeing(' !');
  t.notSeeing(SHELL_HINT);
});

await step('a paste starting with ! into an empty box enters shell mode; into text it does not', async () => {
  const t = open();
  await t.type(`${PASTE_START}!echo pasted${PASTE_END}`);
  await t.seeing(SHELL_HINT);
  await t.seeing('echo pasted');
  t.notSeeing('!echo pasted');
  const u = open();
  await u.type('abc ');
  await u.type(`${PASTE_START}!echo no${PASTE_END}`);
  await u.seeing('abc !echo no');
  u.notSeeing(SHELL_HINT);
});

await step('shell mode has no slash menu; /help and the status line mention !', async () => {
  const t = open();
  await t.seeing('! shell');
  await t.type('!');
  await t.type('/');
  await t.seeing(SHELL_HINT);
  t.notSeeing('Show commands and key bindings');
  await t.type(KEY.esc);
  await t.seeing('Ask anything');
  await t.type('/help');
  await t.type(KEY.enter);
  await t.seeing('! as the first character');
});

/* ---- Composer: running commands ---- */

await step('Enter runs the command: command line, output and exit footer in the thread, nothing sent to an agent', async () => {
  const t = open();
  await t.type('!');
  await t.type(nodeCommand('hi.js'));
  await t.type(KEY.enter);
  await t.seeing('hi from shell');
  await t.seeing('exit 0');
  assert.match(t.frame(), /hi\.js/, 'the command line is shown');
  assert.equal(t.service.starts, 0, 'no run was created');
  await t.seeing(SHELL_HINT);
});

await step('stderr and a non-zero exit are shown; the exit status is in the footer', async () => {
  const t = open();
  await t.type('!');
  await t.type(nodeCommand('mixed.js'));
  await t.type(KEY.enter);
  await t.seeing('exit 3');
  assert.ok(t.frame().includes('to-out') && t.frame().includes('to-err'));
});

await step('carriage-return progress overwrites the line and ANSI/OSC sequences are stripped', async () => {
  const t = open();
  await t.type('!');
  await t.type(nodeCommand('progress.js'));
  await t.type(KEY.enter);
  await t.seeing('exit 0');
  assert.ok(t.frame().includes('progress 100%') && t.frame().includes('done'));
  t.notSeeing('progress 50%');
  const u = open();
  await u.type('!');
  await u.type(nodeCommand('ansi.js'));
  await u.type(KEY.enter);
  await u.seeing('exit 0');
  assert.ok(u.frame().includes('red plain'), u.frame());
  u.notSeeing('window-title');
  u.notSeeing('[31m');
});

await step('a runaway output is capped with an omitted marker', async () => {
  const t = open();
  await t.type('!');
  await t.type(nodeCommand('flood.js'));
  await t.type(KEY.enter);
  await t.seeing('exit 0', 800);
  assert.ok(t.frame().includes('lines omitted'));
  assert.ok(t.frame().includes('line 2999') && t.frame().includes('line 0\n'));
});

await step('a second command is refused while one runs; Ctrl+C kills the whole process tree and does not quit', async () => {
  await rm(path.join(temp, 'pids.txt'), { force: true });
  const t = open();
  await t.type('!');
  await t.type(nodeCommand('long.js'));
  await t.type(KEY.enter);
  await t.seeing('spawned-ok');
  await t.type('echo again');
  await t.type(KEY.enter);
  await t.seeing('still running');
  const [parent, child] = (await readFile(path.join(temp, 'pids.txt'), 'utf8')).split(',').map(Number);
  assert.ok(alive(parent) && alive(child), 'both processes are running');
  await t.type(KEY.ctrlC);
  await t.seeing('interrupted');
  await until(() => !alive(parent) && !alive(child), 'the process tree to die');
  t.notSeeing('Press Ctrl+C again to exit');
  // The kill did not arm quitting: the next Ctrl+C only arms it, and the box still works.
  await t.type(KEY.ctrlC);
  await t.seeing('Press Ctrl+C again to exit');
  await t.type('x');
  await t.seeing('echo againx');
});

await step('cd gets a one-time hint that each command runs in the session folder', async () => {
  const t = open();
  await t.type('!');
  await t.type('cd ..');
  await t.type(KEY.enter);
  await t.seeing('Each ! command runs in');
  await t.seeing('exit 0');
  await t.type('cd ..');
  await t.type(KEY.enter);
  await until(() => t.frame().split('exit 0').length > 2, 'the second exit footer');
  assert.equal(t.frame().split('Each ! command runs in').length - 1, 1, 'the hint is shown once');
});

/* ---- Run active: refusal ---- */

await step('shell mode is refused while an agent run is active (the ! stays as text)', async () => {
  const t = open();
  await t.type('hang please');
  await t.type(KEY.enter);
  await t.seeing('running');
  await t.type('!');
  await t.seeing('Shell mode is unavailable while an agent run is active');
  t.notSeeing(SHELL_HINT);
  assert.match(t.frame(), /│ › !/, 'the ! was typed as plain text');
  await t.type(KEY.ctrlC);
  await t.seeing('cancelled');
  await t.seeing('ready');
  await t.type(KEY.ctrlU);
  await t.type('!');
  await t.seeing(SHELL_HINT);
  assert.equal(t.service.starts, 1);
});

/* ---- History ---- */

await step('history: commands are stored with a leading ! and Up/Down recall them back into shell mode', async () => {
  const file = path.join(temp, 'history.json');
  const t = open({ history: ['normal prompt', '!echo preseed'], historyFile: file });
  await t.type(KEY.up);
  await t.seeing(SHELL_HINT);
  await t.seeing('echo preseed');
  await t.type(KEY.up);
  await t.seeing('normal prompt');
  t.notSeeing(SHELL_HINT);
  await t.type(KEY.down);
  await t.seeing(SHELL_HINT);
  await t.type(KEY.down);
  await t.seeing('Ask anything');
  t.notSeeing(SHELL_HINT);
  await t.type('!');
  await t.type(nodeCommand('hi.js'));
  await t.type(KEY.enter);
  await t.seeing('exit 0');
  await until(() => !t.frame().includes('running…'), 'the command to finish');
  await sleep(150);
  const saved = await loadHistory(file);
  assert.equal(saved.at(-1), `!${nodeCommand('hi.js')}`);
  await t.type(KEY.esc);
  await t.seeing('Ask anything');
  await t.type(KEY.up);
  await t.seeing(SHELL_HINT);
  await t.seeing('hi.js');
});

/* ---- Full screen ---- */

await step('full screen: the same flow works in the fixed layout', async () => {
  const t = open({ screen: 'fullscreen' });
  await t.type('!');
  await t.seeing(SHELL_HINT);
  await t.type(nodeCommand('hi.js'));
  await t.type(KEY.enter);
  await t.seeing('hi from shell');
  await t.seeing('exit 0');
});

await rm(temp, { recursive: true, force: true }).catch(() => undefined);
if (failed) process.exit(1);
console.log('tui shell smoke: all passed');
process.exit(0);
