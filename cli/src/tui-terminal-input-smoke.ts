/**
 * Terminal input smoke test (mouse wheel in the full-screen chat).
 *   pnpm --filter ai-duo-cli test
 *
 * The stdin filter takes mouse reports out before Ink sees them: split and batched reports, bracketed
 * paste and a lone Escape are handled; startTui switches mouse reporting and alternate scroll (1007) on
 * entering and restores them before leaving; a wheel turn scrolls the thread and never changes the
 * composer's draft, history position or shell mode. Arrow fallback cannot recall history either;
 * Ctrl+P/N explicitly recall history and restore the unsent draft.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo terminal input '));
process.env.NO_COLOR = '1';
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
process.env.AI_DUO_SETTINGS_FILE = path.join(temp, 'settings.json');
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([temp]);
delete process.env.AI_DUO_MOUSE;

const { startTui } = await import('./tui/index.tsx');
const { LEAVE_ALT_SCREEN, SHOW_CURSOR } = await import('./tui/screen.ts');
const { ALT_SCROLL_OFF, ALT_SCROLL_RESTORE, InputSplitter, MOUSE_OFF, MOUSE_ON, PARTIAL_FLUSH_MS, TerminalInput, enterModes, leaveModes, mouseEnabled } = await import('./tui/terminalInput.ts');
const { SHELL_HINT } = await import('./tui/Composer.tsx');
type ChatService = import('./tui/useSession.ts').ChatService;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(done: () => boolean, what: string, tries = 200): Promise<void> {
  if (done()) return;
  if (tries <= 0) throw new Error(`timed out waiting for ${what}`);
  await sleep(20);
  return until(done, what, tries - 1);
}

const ESC = '\u001B';
const WHEEL_UP = `${ESC}[<64;10;5M`;
const WHEEL_DOWN = `${ESC}[<65;10;5M`;
const KEY = { enter: '\r', up: `${ESC}[A`, ctrlD: '\u0004' };

class FakeStdin extends EventEmitter {
  isTTY = true;
  raw = false;
  encoding: string | undefined;
  paused = false;
  setEncoding(encoding: string) {
    this.encoding = encoding;
  }
  setRawMode(mode: boolean) {
    this.raw = mode;
  }
  resume() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  ref() {}
  unref() {}
  unshift() {}
  read = () => null;
  /** The real terminal only emits 'data' here; the filter is the one reader. */
  send(text: string) {
    this.emit('data', text);
  }
}

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 24;
  output = '';
  writes: string[] = [];
  write = (chunk: string, cb?: () => void) => {
    this.output += chunk;
    this.writes.push(chunk);
    cb?.();
    return true;
  };
  frameText(): string {
    for (let i = this.writes.length - 1; i >= 0; i--) {
      const text = stripAnsi(this.writes[i]);
      if (text.trim()) return text;
    }
    return '';
  }
}

const ESC_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');
const stripAnsi = (text: string): string => text.replace(ESC_PATTERN, '');

class FakeService {
  preflight = async () => ({ ok: true, checks: [], problems: [], authUnverified: false });
  previewRoute = async () => ({ mode: 'code' as const, coder: 'codex' as const, reviewer: 'claude' as const, maxRounds: 2, route: {} as never, askHaiku: false });
  abortAll = async () => {};
  get = async () => undefined;
}

let failed = false;
const step = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${name}\n${(err as Error).stack}`);
  }
};

/* ---- the splitter ---- */

await step('splitter: wheel reports are taken out, keys and other mouse buttons never reach Ink as keys', () => {
  const s = new InputSplitter();
  assert.deepEqual(s.push(WHEEL_UP), { keys: '', wheel: ['up'] });
  assert.deepEqual(s.push(WHEEL_DOWN), { keys: '', wheel: ['down'] });
  assert.deepEqual(s.push(`${ESC}[<68;1;1M`), { keys: '', wheel: ['up'] }, 'Shift+wheel is still the wheel');
  assert.deepEqual(s.push(`${ESC}[<0;3;4M${ESC}[<0;3;4m${ESC}[<32;5;4M${ESC}[<66;1;1M`), { keys: '', wheel: [] }, 'clicks, drags and horizontal wheel are dropped');
  assert.deepEqual(s.push(`${ESC}[M\`!!${ESC}[Ma!!`), { keys: '', wheel: ['up', 'down'] }, 'legacy X10 reports too');
  assert.deepEqual(s.push(`a${WHEEL_UP}${WHEEL_UP}b${ESC}[A${WHEEL_DOWN}c`), { keys: `ab${ESC}[Ac`, wheel: ['up', 'up', 'down'] }, 'interleaved with typing and arrows');
  assert.deepEqual(s.push('xin chào 👋'), { keys: 'xin chào 👋', wheel: [] }, 'Vietnamese and emoji untouched');
  assert.equal(s.hasPending, false);
});

await step('splitter: a report cut across chunks is held until complete', () => {
  const s = new InputSplitter();
  for (const cut of [1, 2, 3, 5, WHEEL_UP.length - 1]) {
    const first = s.push(`k${WHEEL_UP.slice(0, cut)}`);
    assert.deepEqual(first, { keys: 'k', wheel: [] }, `cut at ${cut}`);
    assert.equal(s.hasPending, true);
    assert.deepEqual(s.push(`${WHEEL_UP.slice(cut)}z`), { keys: 'z', wheel: ['up'] }, `cut at ${cut}`);
    assert.equal(s.hasPending, false);
  }
});

await step('splitter: a lone Escape and other sequences are passed on; bracketed paste is never parsed', () => {
  const s = new InputSplitter();
  const esc = s.push(ESC);
  assert.deepEqual(esc, { keys: '', wheel: [] });
  assert.equal(s.flush(), ESC, 'a held Escape comes out on flush');
  assert.deepEqual(s.push(`${ESC}[1;5A${ESC}\r${ESC}[5~`), { keys: `${ESC}[1;5A${ESC}\r${ESC}[5~`, wheel: [] });
  const paste = `${ESC}[200~text ${WHEEL_UP} more${ESC}[201~`;
  assert.deepEqual(s.push(paste), { keys: paste, wheel: [] }, 'mouse-looking text inside a paste stays text');
  assert.deepEqual(s.push(`${ESC}[200~a`), { keys: `${ESC}[200~a`, wheel: [] });
  assert.deepEqual(s.push(`b${ESC}[20`), { keys: 'b', wheel: [] }, 'a cut end marker is held');
  assert.deepEqual(s.push(`1~${WHEEL_UP}`), { keys: `${ESC}[201~`, wheel: ['up'] }, 'after the paste, reports count again');
});

await step('splitter: the DECRQM answer for alternate scroll is read and removed', () => {
  const s = new InputSplitter();
  assert.deepEqual(s.push(`${ESC}[?1007;1$y`), { keys: '', wheel: [], altScroll: true });
  assert.deepEqual(s.push(`${ESC}[?1007;2$yq`), { keys: 'q', wheel: [], altScroll: false });
  assert.deepEqual(s.push(`${ESC}[?1007;0$y`), { keys: '', wheel: [] }, 'not recognised: unknown');
});

await step('modes: entering switches alternate scroll off (saved first); leaving restores it', () => {
  assert.equal(enterModes(true), ALT_SCROLL_OFF + MOUSE_ON);
  assert.equal(enterModes(false), ALT_SCROLL_OFF);
  assert.ok(ALT_SCROLL_OFF.indexOf('?1007s') < ALT_SCROLL_OFF.indexOf('?1007l'), 'XTSAVE before the reset');
  assert.equal(leaveModes(true, undefined), MOUSE_OFF + ALT_SCROLL_RESTORE, 'no answer: XTRESTORE only, never a guessed 1007h');
  assert.equal(leaveModes(true, true), `${MOUSE_OFF}${ALT_SCROLL_RESTORE}${ESC}[?1007h`);
  assert.equal(leaveModes(false, false), `${ALT_SCROLL_RESTORE}${ESC}[?1007l`);
  assert.equal(mouseEnabled({}), true);
  assert.equal(mouseEnabled({ AI_DUO_MOUSE: '0' }), false);
  assert.equal(mouseEnabled({ AI_DUO_MOUSE: 'off' }), false);
});

await step('TerminalInput: one reader, read() for Ink, wheel to subscribers, raw mode forwarded, dispose stops reading', async () => {
  const source = new FakeStdin();
  const input = new TerminalInput(source as never);
  assert.equal(source.encoding, 'utf8');
  assert.equal(input.isTTY, true);
  const wheel: string[] = [];
  const off = input.onWheel((d) => wheel.push(d));
  let readable = 0;
  input.on('readable', () => readable++);
  source.send(`hi${WHEEL_UP}`);
  assert.deepEqual(wheel, ['up']);
  assert.equal(readable, 1);
  assert.equal(input.read(), 'hi');
  assert.equal(input.read(), null);
  source.send(WHEEL_DOWN);
  assert.equal(readable, 1, 'a report alone wakes nobody');
  source.send(ESC);
  assert.equal(input.read(), null, 'a lone Escape waits for the rest of a possible report');
  await sleep(PARTIAL_FLUSH_MS + 30);
  assert.equal(input.read(), ESC, 'then it is a key');
  source.send(`${ESC}[?1007;1$y`);
  assert.equal(input.altScroll, true);
  input.setRawMode(true);
  assert.equal(source.raw, true);
  off();
  source.send(WHEEL_UP);
  assert.deepEqual(wheel, ['up', 'down']);
  input.dispose();
  input.dispose();
  assert.equal(source.listenerCount('data'), 0);
  assert.equal(source.paused, true);
});

/* ---- the full-screen chat ---- */

interface Session {
  stdin: FakeStdin;
  stdout: FakeStdout;
  done: Promise<number>;
  type(text: string): Promise<void>;
  seeing(text: string): Promise<void>;
}

function open(historyFile: string): Session {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const done = startTui({ cwd: temp, service: new FakeService() as unknown as ChatService, historyFile, skipPreflight: true, stdin: stdin as never, stdout: stdout as never });
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

await step('wheel over an empty composer with a shell command in history: nothing recalled, run or switched', async () => {
  const historyFile = path.join(temp, 'history-shell.json');
  await writeFile(historyFile, JSON.stringify(['! echo still-alive']), 'utf8');
  const s = open(historyFile);
  await s.seeing('Ask anything');
  const enter = s.stdout.output;
  assert.ok(enter.includes(ALT_SCROLL_OFF + MOUSE_ON), 'alternate scroll off and mouse reporting on, with the alternate screen');
  s.stdin.send(`${ESC}[?1007;1$y`);
  for (let i = 0; i < 5; i++) await s.type(WHEEL_UP);
  await s.type(WHEEL_DOWN + WHEEL_UP + WHEEL_DOWN);
  await sleep(100);
  const frame = s.stdout.frameText();
  assert.ok(frame.includes('Ask anything'), `draft still empty:\n${frame}`);
  assert.ok(!frame.includes('still-alive'), 'history was not recalled');
  assert.ok(!frame.includes(SHELL_HINT), 'shell mode stayed off');
  await s.type(KEY.up.repeat(3) + `${ESC}[B`.repeat(3));
  assert.ok(s.stdout.frameText().includes('Ask anything'), 'wheel translated to arrows cannot recall history');
  await s.type('unsent draft');
  await s.type(KEY.up.repeat(3) + `${ESC}[B`.repeat(3));
  assert.ok(s.stdout.frameText().includes('unsent draft'), 'arrow fallback preserves a nonempty draft');
  assert.ok(!s.stdout.frameText().includes('still-alive'), 'arrow fallback cannot replace the draft with history');
  await s.type('\u0010'); // Ctrl+P explicitly recalls history
  await s.seeing('still-alive');
  await s.seeing(SHELL_HINT);
  await s.type(WHEEL_DOWN);
  await sleep(60);
  assert.ok(s.stdout.frameText().includes('still-alive'), 'the wheel does not move through history either');
  await s.type('\u000e'); // Ctrl+N restores the draft
  await s.seeing('unsent draft');
  assert.ok(!s.stdout.frameText().includes(SHELL_HINT), 'restoring a normal draft leaves shell mode');
  await s.type('\u0015'); // Ctrl+U clears the recalled draft
  await s.type(KEY.ctrlD);
  await s.type(KEY.ctrlD);
  assert.equal(await s.done, 0);
  const { output } = s.stdout;
  assert.ok(output.endsWith(`${MOUSE_OFF}${ALT_SCROLL_RESTORE}${ESC}[?1007h${LEAVE_ALT_SCREEN}${SHOW_CURSOR}`), `modes restored before leaving: ${JSON.stringify(output.slice(-80))}`);
  assert.equal(output.split(MOUSE_OFF).length - 1, 1, 'restored once');
  assert.equal(s.stdin.raw, false, 'raw mode off');
  assert.equal(s.stdin.listenerCount('data'), 0, 'the real stdin is released');
  assert.ok(!output.includes('echo still-alive\n'), 'the command never ran');
});

await step('wheel scrolls the thread up and back down to following', async () => {
  const s = open(path.join(temp, 'history-scroll.json'));
  await s.seeing('Ask anything');
  for (let i = 0; i < 4; i++) {
    await s.type('/help');
    await s.type(KEY.enter);
  }
  await sleep(150);
  assert.ok(!s.stdout.frameText().includes('End to jump'), 'following the newest output');
  for (let i = 0; i < 4; i++) await s.type(WHEEL_UP);
  await s.seeing('End to jump');
  for (let i = 0; i < 20; i++) s.stdin.send(WHEEL_DOWN);
  await until(() => !s.stdout.frameText().includes('End to jump'), 'back at the bottom');
  assert.ok(s.stdout.frameText().includes('Ask anything'));
  await s.type(KEY.up.repeat(3));
  await s.seeing('End to jump');
  assert.ok(s.stdout.frameText().includes('Ask anything'), 'arrow fallback scrolls without changing the composer');
  await s.type(`${ESC}[B`.repeat(3));
  await until(() => !s.stdout.frameText().includes('End to jump'), 'arrow fallback returns to following');
  await s.type(KEY.ctrlD);
  assert.equal(await s.done, 0);
});

await step('AI_DUO_MOUSE=0: no mouse reporting, alternate scroll still off and restored', async () => {
  process.env.AI_DUO_MOUSE = '0';
  try {
    const s = open(path.join(temp, 'history-nomouse.json'));
    await s.seeing('Ask anything');
    assert.ok(!s.stdout.output.includes(MOUSE_ON));
    assert.ok(s.stdout.output.includes(ALT_SCROLL_OFF));
    await s.type(KEY.ctrlD);
    assert.equal(await s.done, 0);
    assert.ok(s.stdout.output.endsWith(`${ALT_SCROLL_RESTORE}${LEAVE_ALT_SCREEN}${SHOW_CURSOR}`));
    assert.ok(!s.stdout.output.includes(MOUSE_OFF));
  } finally {
    delete process.env.AI_DUO_MOUSE;
  }
});

await rm(temp, { recursive: true, force: true }).catch(() => {});
if (failed) {
  console.error('TUI terminal input smoke test failed');
  process.exit(1);
}
console.log('TUI terminal input smoke test passed');
process.exit(0);
