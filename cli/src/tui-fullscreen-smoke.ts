/**
 * Full-screen TUI smoke test.
 *   pnpm --filter ai-duo-cli test
 *
 * Runs startTui() on fake TTY streams (no real terminal): the alternate screen is entered and left on
 * every exit path, the frame never exceeds the terminal height, the thread scrolls and follows the
 * newest output, the layout follows resizes, --inline keeps the <Static> path, and the flags parse.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo tui fullscreen '));
process.env.NO_COLOR = '1';
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
process.env.AI_DUO_SETTINGS_FILE = path.join(temp, 'settings.json');
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([temp]);

const { startTui } = await import('./tui/index.tsx');
const { AltScreen, guardProcess, ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, SHOW_CURSOR } = await import('./tui/screen.ts');
const { applyScroll, linesBelow, maxTop, scrollAction, topLine } = await import('./tui/scroll.ts');
const { windowLog, WINDOW_MAX } = await import('./tui/ThreadView.tsx');
const { HELP, main } = await import('./commands.ts');
type ChatService = import('./tui/useSession.ts').ChatService;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(done: () => boolean, what: string, tries = 200): Promise<void> {
  if (done()) return;
  if (tries <= 0) throw new Error(`timed out waiting for ${what}`);
  await sleep(20);
  return until(done, what, tries - 1);
}

const KEY = {
  enter: '\r',
  ctrlC: '\u0003',
  ctrlD: '\u0004',
  pageUp: '\u001B[5~',
  pageDown: '\u001B[6~',
  home: '\u001B[H',
  end: '\u001B[F',
  ctrlHome: '\u001B[1;5H',
  ctrlEnd: '\u001B[1;5F',
  ctrlUp: '\u001B[1;5A',
  ctrlDown: '\u001B[1;5B',
  altUp: '\u001B[1;3A',
  altDown: '\u001B[1;3B',
  up: '\u001B[A',
};

class FakeStdin extends EventEmitter {
  isTTY = true;
  raw = false;
  data: string | null = null;
  setEncoding() {}
  setRawMode(mode: boolean) {
    this.raw = mode;
  }
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  unshift() {}
  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
  send(text: string) {
    this.data = text;
    this.emit('readable');
    this.emit('data', text);
  }
}

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns: number;
  rows: number;
  output = '';
  writes: string[] = [];
  constructor(columns = 100, rows = 24) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write = (chunk: string, cb?: () => void) => {
    this.output += chunk;
    this.writes.push(chunk);
    cb?.();
    return true;
  };
  resize(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
  /** The last frame Ink drew: cursor and erase codes stripped, one string per terminal row. */
  frame(): string[] {
    for (let i = this.writes.length - 1; i >= 0; i--) {
      const text = stripAnsi(this.writes[i]);
      if (text.trim()) return text.replace(/\n$/, '').split('\n');
    }
    return [];
  }
  frameText(): string {
    return this.frame().join('\n');
  }
}

const ESC_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const stripAnsi = (text: string): string => text.replace(ESC_PATTERN, '');

class FakeService {
  cancels = 0;
  preflight = async () => ({ ok: true, checks: [], problems: [], authUnverified: false });
  previewRoute = async () => ({ mode: 'code' as const, coder: 'codex' as const, reviewer: 'claude' as const, maxRounds: 2, route: {} as never, askHaiku: false });
  abortAll = async () => {};
  get = async () => undefined;
}

const historyFile = path.join(temp, 'history.json');

interface Session {
  stdin: FakeStdin;
  stdout: FakeStdout;
  done: Promise<number>;
  type(text: string): Promise<void>;
  seeing(text: string): Promise<void>;
}

function open(columns = 100, rows = 24, screen?: 'inline' | 'fullscreen'): Session {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(columns, rows);
  const done = startTui({ cwd: temp, service: new FakeService() as unknown as ChatService, historyFile, skipPreflight: true, stdin: stdin as never, stdout: stdout as never, screen });
  return {
    stdin,
    stdout,
    done,
    type: async (text) => {
      stdin.send(text);
      await sleep(40);
    },
    seeing: (text) => until(() => stdout.frameText().includes(text), `"${text}"\n${stdout.frameText()}`),
  };
}

/** Runs /help n times: each adds a long notice to the thread. */
async function fill(s: Session, times: number) {
  for (let i = 0; i < times; i++) {
    await s.type('/help');
    await s.type(KEY.enter);
  }
  await sleep(150);
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

let failed = false;
const step = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${name}\n${(err as Error).stack}`);
  }
};

/* ---- pure pieces ---- */

await step('scroll maths: anchor, pages, following resumes at the bottom', async () => {
  const m = { view: 10, content: 100 };
  assert.equal(maxTop(m), 90);
  assert.equal(topLine(null, m), 90);
  assert.equal(topLine(500, m), 90);
  assert.equal(applyScroll(null, m, { kind: 'by', lines: -9 }), 81);
  assert.equal(applyScroll(81, m, { kind: 'by', lines: 9 }), null);
  assert.equal(applyScroll(81, m, { kind: 'by', lines: 3 }), 84);
  assert.equal(applyScroll(null, m, { kind: 'top' }), 0);
  assert.equal(applyScroll(4, m, { kind: 'bottom' }), null);
  assert.equal(applyScroll(null, { view: 10, content: 4 }, { kind: 'by', lines: -3 }), null);
  assert.equal(linesBelow(50, m), 40);
  assert.equal(linesBelow(null, m), 0);
  const key = (k: object) => ({ upArrow: false, downArrow: false, pageUp: false, pageDown: false, home: false, end: false, ctrl: false, meta: false, ...k }) as never;
  assert.deepEqual(scrollAction(key({ pageUp: true }), m, false), { kind: 'by', lines: -9 });
  assert.deepEqual(scrollAction(key({ upArrow: true, ctrl: true }), m, false), { kind: 'by', lines: -1 });
  assert.deepEqual(scrollAction(key({ downArrow: true, meta: true }), m, false), { kind: 'by', lines: 1 });
  assert.equal(scrollAction(key({ upArrow: true }), m, true), null, 'plain Up belongs to the composer');
  assert.equal(scrollAction(key({ home: true }), m, false), null, 'plain Home belongs to the composer while it has text');
  assert.deepEqual(scrollAction(key({ home: true }), m, true), { kind: 'top' });
  assert.deepEqual(scrollAction(key({ end: true, ctrl: true }), m, false), { kind: 'bottom' });
});

await step('windowLog drops the header and cuts a long log from the front in blocks', async () => {
  const items = (n: number) => [{ id: 'h', kind: 'header' as const, cwd: '', version: '' }, ...Array.from({ length: n }, (_, i) => ({ id: `n${i}`, kind: 'notice' as const, tone: 'info' as const, text: 'x' }))];
  assert.deepEqual(windowLog(items(5)), { items: items(5).slice(1), hidden: 0 });
  const long = windowLog(items(WINDOW_MAX + 30));
  assert.equal(long.hidden, 100);
  assert.equal(long.items.length, WINDOW_MAX + 30 - 100);
  assert.equal(long.items[0].id, 'n100');
});

/* ---- flags and help ---- */

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (c: string) => out.push(c) } as never, stderr: { write: (c: string) => err.push(c), isTTY: false } as never };
}

await step('HELP documents --inline, --fullscreen and the scroll keys', async () => {
  for (const needle of ['--inline', '--fullscreen', 'AI_DUO_INLINE', 'PageUp/PageDown']) assert.ok(HELP.includes(needle), needle);
});

await step('flags: bare ai-duo without a terminal prints HELP and exits 2; chat needs a TTY; both flags conflict', async () => {
  const io = (tty: boolean, env: NodeJS.ProcessEnv = {}) => {
    const c = capture();
    const stdin = Object.assign(new EventEmitter(), { isTTY: tty });
    const stdout = Object.assign(c.stdout, { isTTY: tty });
    return { c, io: { stdin: stdin as never, stdout, stderr: c.stderr, env, cwd: temp, onInterrupt: () => () => {} } };
  };
  const bare = io(false);
  assert.equal(await main([], bare.io), 2);
  assert.ok(bare.c.err.join('').includes('Usage:'));
  const chat = io(false);
  assert.equal(await main(['chat'], chat.io), 2);
  assert.ok(chat.c.err.join('').includes('needs an interactive terminal'));
  const inlineNoTty = io(false);
  assert.equal(await main(['chat', '--inline'], inlineNoTty.io), 2, '--inline changes nothing about the TTY requirement');
  const both = io(true);
  assert.equal(await main(['chat', '--inline', '--fullscreen', '-C', temp], both.io), 2);
  assert.ok(both.c.err.join('').includes('either --inline or --fullscreen'));
  const help = io(true);
  assert.equal(await main(['--help'], help.io), 0);
  assert.ok(help.c.out.join('').includes('--inline'));
});

/* ---- alternate screen lifecycle ---- */

await step('AltScreen: enter and leave once, leave is idempotent, cursor shown, raw mode off', async () => {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const alt = new AltScreen(stdout as never, stdin as never);
  alt.leave();
  assert.equal(stdout.output, '', 'leaving before entering writes nothing');
  alt.enter();
  alt.enter();
  stdin.raw = true;
  alt.leave();
  alt.leave();
  assert.equal(stdout.output, ENTER_ALT_SCREEN + LEAVE_ALT_SCREEN + SHOW_CURSOR);
  assert.equal(stdin.raw, false);
});

await step('guardProcess: an uncaught error or a signal leaves the alternate screen before printing', async () => {
  for (const trigger of ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGHUP'] as const) {
    const stdout = new FakeStdout();
    const stderr = new FakeStdout();
    const proc = new EventEmitter();
    const exits: number[] = [];
    const alt = new AltScreen(stdout as never);
    let unmounted = 0;
    alt.enter();
    const dispose = guardProcess({ screen: alt, unmount: () => unmounted++, stderr: stderr as never, exit: (code) => exits.push(code), proc: proc as never });
    proc.emit(trigger, new Error('boom'));
    assert.equal(unmounted, 1, trigger);
    assert.ok(stdout.output.endsWith(LEAVE_ALT_SCREEN + SHOW_CURSOR), `${trigger}: left the alternate screen`);
    assert.equal(exits.length, 1, trigger);
    assert.equal(stderr.output.includes('boom'), trigger.startsWith('un'), `${trigger}: error text printed only for errors`);
    dispose();
    assert.equal(proc.listenerCount(trigger), 0, `${trigger}: listener removed`);
  }
  const stdout = new FakeStdout();
  const proc = new EventEmitter();
  const alt = new AltScreen(stdout as never);
  alt.enter();
  guardProcess({ screen: alt, unmount: () => {}, exit: () => {}, proc: proc as never });
  proc.emit('exit', 0);
  assert.ok(stdout.output.endsWith(LEAVE_ALT_SCREEN + SHOW_CURSOR), 'process exit is the last safety net');
});

const enters = (out: string) => count(out, '\u001B[?1049h');
const leaves = (out: string) => count(out, '\u001B[?1049l');

await step('startTui fullscreen: enters once, leaves once on Ctrl+D, Ctrl+C twice and /exit', async () => {
  for (const quit of [[KEY.ctrlD], [KEY.ctrlC, KEY.ctrlC], ['/exit', KEY.enter]]) {
    const s = open();
    await s.seeing('Ask anything');
    assert.ok(s.stdout.output.startsWith(ENTER_ALT_SCREEN), 'alternate screen entered before the first frame');
    for (const key of quit) await s.type(key);
    assert.equal(await s.done, 0);
    const { output } = s.stdout;
    assert.equal(enters(output), 1, JSON.stringify(quit));
    assert.equal(leaves(output), 1, JSON.stringify(quit));
    assert.ok(output.lastIndexOf('\u001B[?1049l') > output.lastIndexOf('Ask anything'), 'primary screen restored after the last frame');
    assert.equal(s.stdin.raw, false, 'raw mode off');
    assert.ok(output.includes(SHOW_CURSOR));
  }
});

await step('startTui: a render error leaves the alternate screen and rejects, so the caller prints it on the primary screen', async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const service = new FakeService();
  // A run whose finished message has no parts: rendering it throws inside React.
  (service as unknown as { start: ChatService['start'] }).start = async (_request, options) => {
    const run = { id: 'r1', config: { mode: 'code', prompt: 'hi', cwd: temp }, status: 'running', createdAt: 1, messages: [{ id: 'm1', agent: 'claude', phase: 'code', round: 1, title: 'boom', parts: null, status: 'done', model: 'x', startedAt: 1 }] };
    options?.onCreated?.(run as never);
    return { run, done: new Promise(() => {}), cancel() {} } as never;
  };
  const running = startTui({ cwd: temp, service: service as unknown as ChatService, historyFile, skipPreflight: true, stdin: stdin as never, stdout: stdout as never });
  const outcome = running.then(
    () => 'exited',
    (err: unknown) => (err as Error).name,
  );
  await until(() => stdout.frameText().includes('Ask anything'), 'first frame');
  stdin.send('hello');
  await sleep(40);
  stdin.send(KEY.enter);
  assert.equal(await outcome, 'TypeError');
  assert.equal(enters(stdout.output), 1);
  assert.equal(leaves(stdout.output), 1);
  assert.ok(stdout.output.endsWith(LEAVE_ALT_SCREEN + SHOW_CURSOR) || stdout.output.lastIndexOf(LEAVE_ALT_SCREEN) > stdout.output.lastIndexOf('Ask anything'), 'left the alternate screen last');
  assert.equal(stdin.raw, false);
});

await step('inline screen: no alternate screen, still prints through <Static>', async () => {
  const s = open(100, 24, 'inline');
  await s.seeing('Ask anything');
  await fill(s, 2);
  assert.equal(enters(s.stdout.output), 0);
  await s.type(KEY.ctrlD);
  assert.equal(await s.done, 0);
  assert.equal(leaves(s.stdout.output), 0);
  // Inline frames grow with the thread instead of being cut to the terminal height.
  assert.ok(s.stdout.output.includes('Commands:'));
});

/* ---- layout and scrolling ---- */

await step('fullscreen: header on top, status at the bottom, frame never taller than the terminal', async () => {
  const s = open(100, 24);
  await s.seeing('Ask anything');
  await fill(s, 12);
  const frame = s.stdout.frame();
  assert.ok(frame.length <= 24, `${frame.length} rows`);
  assert.ok(frame[0].includes('AI Duo'), 'fixed header on the first row');
  assert.ok(frame.at(-1)?.includes('Ctrl+C exit'), 'status hint pinned to the last row');
  for (const line of s.stdout.writes.map(stripAnsi)) assert.ok(line.split('\n').length <= 25, 'no frame taller than the terminal');
  assert.ok(frame.join('\n').includes('Commands:') || frame.join('\n').includes('/exit'), 'newest output visible (following)');
  await s.type(KEY.ctrlD);
  await s.done;
});

await step('fullscreen: scroll up pauses following and shows the hint; End and sending resume', async () => {
  const s = open(100, 24);
  await s.seeing('Ask anything');
  await fill(s, 12);
  const bottom = s.stdout.frameText();
  assert.ok(!bottom.includes('End to jump'), 'no hint while following');
  await s.type(KEY.pageUp);
  await until(() => s.stdout.frameText().includes('End to jump'), 'hint after PageUp');
  const paused = s.stdout.frameText();
  assert.notEqual(paused, bottom);
  assert.match(paused, /↓ \d+ new lines? · End to jump/);
  assert.ok(s.stdout.frame().length <= 24);
  const before = s.stdout.frameText();
  await fill(s, 1);
  assert.match(s.stdout.frameText(), /↓ \d+ new lines/, 'still paused after new output');
  const after = Number(/↓ (\d+) new/.exec(s.stdout.frameText())?.[1]);
  assert.ok(after > Number(/↓ (\d+) new/.exec(before)?.[1]), 'the unseen count grows');
  await s.type(KEY.end);
  await until(() => !s.stdout.frameText().includes('End to jump'), 'following resumed by End');
  await s.type(KEY.ctrlUp);
  await until(() => s.stdout.frameText().includes('End to jump'), 'Ctrl+Up scrolls one line');
  await s.type(KEY.altDown);
  await until(() => !s.stdout.frameText().includes('End to jump'), 'Alt+Down back to the bottom');
  await s.type(KEY.altUp);
  await until(() => s.stdout.frameText().includes('End to jump'), 'Alt+Up scrolls one line');
  await s.type(KEY.ctrlDown);
  await s.type(KEY.pageUp);
  await s.type(KEY.ctrlHome);
  await s.type(KEY.pageDown);
  await s.type(KEY.ctrlEnd);
  await until(() => !s.stdout.frameText().includes('End to jump'), 'Ctrl+End resumes following');
  await s.type(KEY.pageUp);
  await until(() => s.stdout.frameText().includes('End to jump'), 'paused again');
  await s.type('/help');
  await s.type(KEY.enter);
  // A message that is not a slash command follows the newest output: it needs a service, so use the empty-composer Home/End instead.
  await s.type(KEY.home);
  await s.type(KEY.end);
  await until(() => !s.stdout.frameText().includes('End to jump'), 'End on an empty composer resumes');
  await s.type(KEY.ctrlD);
  await s.done;
});

await step('fullscreen: Home shows the top of the thread; plain Up/Down stay with the composer history', async () => {
  const s = open(100, 24);
  await s.seeing('Ask anything');
  await fill(s, 12);
  await s.type(KEY.ctrlHome);
  await until(() => s.stdout.frameText().includes('End to jump'), 'scrolled to the top');
  const top = s.stdout.frameText();
  assert.ok(top.includes('Commands:'), 'first /help output at the top');
  assert.ok(!top.includes('READY') || top.includes('End to jump'));
  await s.type(KEY.up);
  assert.equal(s.stdout.frameText().includes('End to jump'), true, 'plain Up did not scroll');
  await s.type(KEY.ctrlEnd);
  await s.type(KEY.ctrlD);
  await s.done;
});

await step('fullscreen: resize re-lays out to the new size, never taller than the terminal', async () => {
  const s = open(100, 30);
  await s.seeing('Ask anything');
  await fill(s, 8);
  assert.ok(s.stdout.frame().length <= 30);
  s.stdout.resize(60, 12);
  await until(() => s.stdout.frame().length <= 12 && s.stdout.frame().length >= 8, 'shrunk frame');
  assert.ok(s.stdout.frame().every((line) => line.length <= 60), 'lines fit the new width');
  assert.ok(s.stdout.frame()[0].includes('AI Duo'));
  s.stdout.resize(120, 40);
  await until(() => s.stdout.frame().length > 30, 'grown frame');
  assert.ok(s.stdout.frame().length <= 40);
  await s.type(KEY.ctrlD);
  await s.done;
});

await step('fullscreen: a panel fits the terminal height and Esc brings the thread back', async () => {
  const s = open(100, 16);
  await s.seeing('Ask anything');
  await fill(s, 3);
  await s.type('/roles');
  await s.type(KEY.enter);
  await sleep(300);
  assert.ok(s.stdout.frame().length <= 16, `${s.stdout.frame().length} rows with a panel open`);
  await s.type('\u001B');
  await sleep(200);
  await s.seeing('Ask anything');
  assert.ok(s.stdout.frame().length <= 16);
  await s.type(KEY.ctrlD);
  await s.done;
});

await rm(temp, { recursive: true, force: true }).catch(() => {});
if (failed) {
  console.error('TUI fullscreen smoke test failed');
  process.exit(1);
}
console.log('TUI fullscreen smoke test passed');
process.exit(0);
