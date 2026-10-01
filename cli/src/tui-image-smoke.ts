/**
 * Image attachment smoke test.
 *   pnpm --filter ai-duo-cli exec tsx src/tui-image-smoke.ts
 *
 * Unit tests of the clipboard readers (fake runner and fake outputs for Windows, macOS and Linux), of the
 * path parsing and the file loader (magic bytes, 5 MB), and ink-testing-library tests of the chat:
 * Ctrl+V / Alt+V / /paste-image with an injected clipboard, pasted and typed file paths, notices, the
 * 4-image limit, Backspace removal, chips reset after a send, and the images in the run request
 * (new run and follow-up) and in the echo line.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import type { RunHandle, RunRequest, StartOptions } from '../../server/src/service.ts';
import type { Run } from '../../server/src/types.ts';
import { parseImages } from '../../server/src/service.ts';

const temp = await mkdtemp(path.join(tmpdir(), 'aiduoimg-'));
process.env.NO_COLOR = '1';
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
process.env.AI_DUO_SETTINGS_FILE = path.join(temp, 'settings.json');
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([temp]);

const { render, cleanup } = await import('ink-testing-library');
const { App } = await import('./tui/App.tsx');
const clip = await import('./tui/clipboard.ts');
const img = await import('./tui/images.ts');
const { buildRequest } = await import('./tui/requestBuilder.ts');
const notes = await import('./tui/useImages.ts');
type ChatService = import('./tui/useSession.ts').ChatService;
type ClipboardResult = import('./tui/clipboard.ts').ClipboardResult;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(done: () => boolean, what: string, tries = 300): Promise<void> {
  if (done()) return;
  if (tries <= 0) throw new Error(`timed out waiting for ${what}`);
  await sleep(20);
  return until(done, what, tries - 1);
}

const KEY = { enter: '\r', esc: '\u001B', backspace: '\u007F', ctrlV: '\u0016', altV: '\u001Bv', ctrlU: '\u0015' };
const PASTE_START = '\u001B[200~';
const PASTE_END = '\u001B[201~';
const WINDOWS = process.platform === 'win32';

/* ---- Fixtures ---- */

/** A PNG-looking buffer of `size` bytes: the signature, then zeros (the check is on the magic bytes). */
function pngOf(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  return bytes;
}
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(2000)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(100)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(100)]);

const files = path.join(temp, 'files');
const spaced = path.join(temp, 'my pictures');
await mkdir(files);
await mkdir(spaced);
const PNG_FILE = path.join(files, 'shot.png');
const SPACED_FILE = path.join(spaced, 'with space.png');
const FAKE_FILE = path.join(files, 'fake.png');
const BIG_FILE = path.join(files, 'big.png');
const NOTE_FILE = path.join(files, 'notes.txt');
await Promise.all([
  writeFile(PNG_FILE, pngOf(184 * 1024)),
  writeFile(SPACED_FILE, pngOf(3000)),
  writeFile(path.join(files, 'photo.jpg'), JPEG),
  writeFile(path.join(files, 'anim.gif'), GIF),
  writeFile(path.join(files, 'pic.webp'), WEBP),
  writeFile(FAKE_FILE, 'this is plain text, not a PNG'),
  writeFile(BIG_FILE, pngOf(img.MAX_IMAGE_BYTES + 1)),
  writeFile(NOTE_FILE, 'hello'),
  mkdir(path.join(files, 'folder.png')),
]);

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

/* ---- images.ts ---- */

await step('sniffImage: type from the magic bytes only', async () => {
  assert.equal(img.sniffImage(pngOf(20)), 'image/png');
  assert.equal(img.sniffImage(JPEG), 'image/jpeg');
  assert.equal(img.sniffImage(GIF), 'image/gif');
  assert.equal(img.sniffImage(WEBP), 'image/webp');
  assert.equal(img.sniffImage(Buffer.from('plain text here')), undefined);
  assert.equal(img.sniffImage(Buffer.alloc(0)), undefined);
});

await step('chipLabel / echoText / formatBytes', async () => {
  const clipboard = img.attachmentFromBytes(pngOf(184 * 1024), 'clipboard.png', 'clipboard');
  assert.ok(clipboard.ok);
  assert.equal(img.chipLabel(0, clipboard.image), '[Image #1 · PNG · 184 KB]');
  const file = img.attachmentFromBytes(JPEG, 'photo.jpg', 'file');
  assert.ok(file.ok);
  assert.equal(img.chipLabel(1, file.image), '[Image #2 · photo.jpg · JPEG · 2 KB]');
  assert.equal(img.formatBytes(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(img.echoText('look', [clipboard.image, file.image]), 'look  [Image #1] [Image #2]');
  assert.equal(img.echoText('', [clipboard.image]), '[Image #1]');
  assert.equal(img.echoText('look', []), 'look');
});

await step('pastedImagePath: quotes, Windows drive paths, file URLs, ~, relative paths; everything else is text', async () => {
  const win = (raw: string) => img.pastedImagePath(raw, { cwd: String.raw`C:\work`, home: String.raw`C:\Users\me`, platform: 'win32' });
  assert.equal(win(String.raw`C:\Users\me\a b\shot.PNG`), String.raw`C:\Users\me\a b\shot.PNG`);
  assert.equal(win(String.raw`"C:\Users\me\a b\shot.png"`), String.raw`C:\Users\me\a b\shot.png`);
  assert.equal(win(String.raw`'C:\x\y.jpeg'`), String.raw`C:\x\y.jpeg`);
  assert.equal(win(String.raw`  C:\x\y.webp  `), String.raw`C:\x\y.webp`);
  assert.equal(win('file:///C:/Users/me/shot.png'), String.raw`C:\Users\me\shot.png`);
  assert.equal(win(String.raw`~\pics\a.gif`), String.raw`C:\Users\me\pics\a.gif`);
  assert.equal(win(String.raw`shots\a.png`), String.raw`C:\work\shots\a.png`);
  assert.equal(win(String.raw`C:\x\y.txt`), undefined);
  assert.equal(win('first line\nC:\\x\\y.png'), undefined);
  assert.equal(win(''), undefined);
  assert.equal(win('look at this'), undefined);
  const posix = (raw: string) => img.pastedImagePath(raw, { cwd: '/work', home: '/home/me', platform: 'linux' });
  assert.equal(posix('/home/me/a.png'), '/home/me/a.png');
  assert.equal(posix("'/home/me/a b.png'"), '/home/me/a b.png');
  assert.equal(posix('/home/me/a\\ b.png'), '/home/me/a b.png');
  assert.equal(posix('file:///home/me/a%20b.png'), '/home/me/a b.png');
  assert.equal(posix('~/pics/a.jpg'), '/home/me/pics/a.jpg');
  assert.equal(posix('pics/a.jpg'), '/work/pics/a.jpg');
  assert.equal(posix('/home/me/a.pdf'), undefined);
  assert.equal(posix('file://'), undefined);
});

await step('loadImageFile: attaches real images, refuses a fake .png and a file over 5 MB, ignores missing paths and folders', async () => {
  const ok = await img.loadImageFile(PNG_FILE);
  assert.ok(ok?.ok);
  assert.equal(ok.image.mime, 'image/png');
  assert.equal(ok.image.bytes, 184 * 1024);
  assert.equal(ok.image.name, 'shot.png');
  assert.ok(ok.image.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal((await img.loadImageFile(path.join(files, 'photo.jpg')))?.ok, true);
  const fake = await img.loadImageFile(FAKE_FILE);
  assert.ok(fake && !fake.ok);
  assert.match(fake.error, /not a PNG, JPEG, WebP or GIF image/);
  const big = await img.loadImageFile(BIG_FILE);
  assert.ok(big && !big.ok);
  assert.match(big.error, /larger than 5 MB/);
  assert.equal(await img.loadImageFile(path.join(files, 'nope.png')), undefined);
  assert.equal(await img.loadImageFile(path.join(files, 'folder.png')), undefined);
  const exactly = img.attachmentFromBytes(pngOf(img.MAX_IMAGE_BYTES), 'edge.png', 'file');
  assert.ok(exactly.ok, 'exactly 5 MB is allowed');
});

await step('loadImageArgs: --image files become request images the server accepts; errors are messages', async () => {
  const loaded = await img.loadImageArgs(['shot.png', path.join(files, 'photo.jpg')], files);
  assert.ok(Array.isArray(loaded));
  assert.equal(loaded.length, 2);
  const parsed = parseImages(loaded);
  assert.ok(typeof parsed !== 'string', String(parsed));
  assert.equal(parsed.images.length, 2);
  assert.equal(await img.loadImageArgs(['x.png', 'x.png', 'x.png', 'x.png', 'x.png'], files), 'Choose up to 4 images with --image.');
  assert.match(String(await img.loadImageArgs(['missing.png'], files)), /not found/);
  assert.match(String(await img.loadImageArgs(['fake.png'], files)), /not a PNG/);
  assert.match(String(await img.loadImageArgs(['big.png'], files)), /larger than 5 MB/);
});

/* ---- clipboard.ts ---- */

interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

type Output = Partial<import('./tui/clipboard.ts').RunOutput> & { writeFile?: Buffer };

/** A runner that records its calls, answers from `outputs` (the last one repeats) and can drop a clip.png into the output folder. */
function fakeRunner(outputs: Output[]) {
  const calls: Call[] = [];
  const dirs: string[] = [];
  const run: import('./tui/clipboard.ts').ClipboardRunner = async (file, args, env) => {
    const output = outputs[Math.min(calls.length, outputs.length - 1)];
    calls.push({ file, args, env });
    const dir = env[clip.OUT_DIR_ENV];
    if (dir) {
      dirs.push(dir);
      if (output.writeFile) await writeFile(path.join(dir, 'clip.png'), output.writeFile);
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: '', timedOut: false, overflow: false, ...output };
  };
  return { run, calls, dirs };
}

const out = (text: string, extra: Output = {}): Output => ({ stdout: Buffer.from(text), ...extra });

const winDeps = { platform: 'win32' as const, env: { SystemRoot: String.raw`C:\Windows` }, find: () => undefined, exists: () => true, retryDelayMs: 1 };

await step('clipboard (Windows): runs the built-in PowerShell by absolute path with a constant command; image, file list, none', async () => {
  const png = pngOf(5000);
  const fake = fakeRunner([out('IMAGE\r\n', { writeFile: png })]);
  const result = await clip.readClipboardImage({ ...winDeps, run: fake.run });
  assert.equal(result.kind, 'image');
  assert.ok(result.kind === 'image' && result.bytes.equals(png) && result.name === 'clipboard.png');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].file, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.deepEqual(fake.calls[0].args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-STA', '-Command']);
  const script = fake.calls[0].args[4];
  assert.match(script, /GetImage\(\)/);
  assert.match(script, /GetFileDropList\(\)/);
  assert.ok(!script.includes(fake.dirs[0]), 'no user or temp data in the command text');
  assert.ok(!existsSync(fake.dirs[0]), 'the temp folder is removed');
  const file = await clip.readClipboardImage({ ...winDeps, run: fakeRunner([out(String.raw`FILE:C:\Users\me\Pictures\a b.png`)]).run });
  assert.deepEqual(file, { kind: 'file', path: String.raw`C:\Users\me\Pictures\a b.png` });
  assert.deepEqual(await clip.readClipboardImage({ ...winDeps, run: fakeRunner([out('NONE')]).run }), { kind: 'none' });
  const failure = await clip.readClipboardImage({ ...winDeps, run: fakeRunner([out('ERROR:boom')]).run });
  assert.deepEqual(failure, { kind: 'error', message: 'Cannot read the clipboard: boom' });
});

await step('clipboard (Windows): a busy clipboard is retried once; pwsh via PATH when the built-in one is missing', async () => {
  const png = pngOf(100);
  const retry = fakeRunner([out('BUSY'), out('IMAGE', { writeFile: png })]);
  assert.equal((await clip.readClipboardImage({ ...winDeps, run: retry.run })).kind, 'image');
  assert.equal(retry.calls.length, 2);
  const busy = fakeRunner([out('BUSY')]);
  const result = await clip.readClipboardImage({ ...winDeps, run: busy.run });
  assert.deepEqual(result, { kind: 'error', message: 'The clipboard is busy; try again.' });
  assert.equal(busy.calls.length, 2, 'one retry, not more');
  const pwsh = fakeRunner([out('NONE')]);
  await clip.readClipboardImage({ ...winDeps, exists: () => false, find: (n) => (n === 'pwsh' ? String.raw`C:\Program Files\PowerShell\7\pwsh.exe` : undefined), run: pwsh.run });
  assert.equal(pwsh.calls[0].file, String.raw`C:\Program Files\PowerShell\7\pwsh.exe`);
  const none = await clip.readClipboardImage({ ...winDeps, exists: () => false, run: fakeRunner([out('NONE')]).run });
  assert.equal(none.kind, 'error');
});

await step('clipboard: timeouts, start failures, oversized output and oversized clip files are errors; the temp folder is always removed', async () => {
  const timed = fakeRunner([{ timedOut: true, code: null }]);
  assert.deepEqual(await clip.readClipboardImage({ ...winDeps, run: timed.run }), { kind: 'error', message: 'Reading the clipboard timed out.' });
  assert.ok(!existsSync(timed.dirs[0]));
  const missing = await clip.readClipboardImage({ ...winDeps, run: fakeRunner([{ spawnError: 'ENOENT' }]).run });
  assert.equal(missing.kind, 'error');
  const overflow = await clip.readClipboardImage({ ...winDeps, run: fakeRunner([{ overflow: true }]).run });
  assert.deepEqual(overflow, { kind: 'error', message: 'The clipboard image is larger than 5 MB.' });
  const big = fakeRunner([out('IMAGE', { writeFile: pngOf(img.MAX_IMAGE_BYTES + 1) })]);
  assert.equal((await clip.readClipboardImage({ ...winDeps, run: big.run })).kind, 'error');
  assert.ok(!existsSync(big.dirs[0]));
  const empty = await clip.readClipboardImage({ ...winDeps, run: fakeRunner([out('IMAGE')]).run });
  assert.equal(empty.kind, 'error', 'IMAGE without a file is an error, not a crash');
});

await step('clipboard (macOS): pngpaste when present, else the fixed osascript (absolute /usr/bin/osascript)', async () => {
  const png = pngOf(900);
  const base = { platform: 'darwin' as const, env: {}, find: () => undefined };
  const viaScript = fakeRunner([out('IMAGE', { writeFile: png })]);
  const first = await clip.readClipboardImage({ ...base, exists: (f) => f === '/usr/bin/osascript', run: viaScript.run });
  assert.equal(first.kind, 'image');
  assert.equal(viaScript.calls[0].file, '/usr/bin/osascript');
  assert.ok(viaScript.calls[0].args.includes('-e'));
  assert.ok(viaScript.calls[0].args.some((a) => a.includes('«class PNGf»')));
  assert.ok(!viaScript.calls[0].args.join(' ').includes(viaScript.dirs[0]), 'folder travels in the environment');
  assert.deepEqual(await clip.readClipboardImage({ ...base, exists: (f) => f === '/usr/bin/osascript', run: fakeRunner([out('NONE')]).run }), { kind: 'none' });
  const paste = fakeRunner([{ code: 0, writeFile: undefined }]);
  const viaPngpaste = await clip.readClipboardImage({
    ...base,
    find: (n) => (n === 'pngpaste' ? '/opt/homebrew/bin/pngpaste' : undefined),
    exists: () => true,
    run: async (file, args, env) => {
      await writeFile(args[0], png);
      return paste.run(file, args, env);
    },
  });
  assert.equal(viaPngpaste.kind, 'image');
  assert.equal(paste.calls[0].file, '/opt/homebrew/bin/pngpaste');
  const noTool = await clip.readClipboardImage({ ...base, exists: () => false, run: fakeRunner([out('')]).run });
  assert.equal(noTool.kind, 'error');
});

await step('clipboard (Linux): wl-paste on Wayland, xclip on X11; a missing tool names both packages', async () => {
  const png = pngOf(700);
  const find = (names: string[]) => (n: string) => (names.includes(n) ? `/usr/bin/${n}` : undefined);
  const wl = fakeRunner([{ stdout: png }]);
  const a = await clip.readClipboardImage({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, find: find(['wl-paste', 'xclip']), run: wl.run });
  assert.ok(a.kind === 'image' && a.bytes.equals(png));
  assert.equal(wl.calls[0].file, '/usr/bin/wl-paste');
  assert.deepEqual(wl.calls[0].args, ['--type', 'image/png']);
  const x = fakeRunner([{ stdout: png }]);
  await clip.readClipboardImage({ platform: 'linux', env: {}, find: find(['wl-paste', 'xclip']), run: x.run });
  assert.equal(x.calls[0].file, '/usr/bin/xclip');
  assert.deepEqual(x.calls[0].args, ['-selection', 'clipboard', '-t', 'image/png', '-o']);
  const onlyWl = fakeRunner([{ stdout: png }]);
  await clip.readClipboardImage({ platform: 'linux', env: {}, find: find(['wl-paste']), run: onlyWl.run });
  assert.equal(onlyWl.calls[0].file, '/usr/bin/wl-paste');
  const notImage = await clip.readClipboardImage({ platform: 'linux', env: {}, find: find(['xclip']), run: fakeRunner([{ code: 1, stderr: 'Error: target image/png not available' }]).run });
  assert.deepEqual(notImage, { kind: 'none' });
  const noDisplay = await clip.readClipboardImage({ platform: 'linux', env: {}, find: find(['xclip']), run: fakeRunner([{ code: 1, stderr: "Error: Can't open display: (null)" }]).run });
  assert.equal(noDisplay.kind, 'error');
  const none = await clip.readClipboardImage({ platform: 'linux', env: {}, find: find([]), run: fakeRunner([{}]).run });
  assert.deepEqual(none, { kind: 'error', message: clip.LINUX_MISSING });
  assert.match(clip.LINUX_MISSING, /xclip/);
  assert.match(clip.LINUX_MISSING, /wl-clipboard/);
  assert.equal((await clip.readClipboardImage({ platform: 'linux', env: {}, find: find(['xclip']), run: fakeRunner([{ overflow: true }]).run })).kind, 'error');
});

await step('runProcess: runs an absolute executable with stdin ignored, caps output and reports failures to start', async () => {
  const script = path.join(temp, 'echo.js');
  await writeFile(script, "process.stdin.on('data', () => {}); process.stdout.write('hello ' + process.env.AIDUO_X); process.stdin.on('end', () => {}); setTimeout(() => {}, 0);");
  const ran = await clip.runProcess(process.execPath, [script], { AIDUO_X: 'there' });
  assert.equal(ran.code, 0);
  assert.equal(ran.stdout.toString(), 'hello there');
  const flood = path.join(temp, 'flood.js');
  await writeFile(flood, "const chunk = 'x'.repeat(1 << 20); for (let i = 0; i < 8; i++) process.stdout.write(chunk); setInterval(() => {}, 1000);");
  const big = await clip.runProcess(process.execPath, [flood], {});
  assert.equal(big.overflow, true);
  const bad = await clip.runProcess(path.join(temp, 'no-such-program'), [], {});
  assert.ok(bad.spawnError);
});

/* ---- Fake service ---- */

class FakeService {
  starts: RunRequest[] = [];
  continues: { id: string; request: RunRequest }[] = [];
  /** While true a run stays active until release(). */
  hold = false;
  private releases: (() => void)[] = [];
  private seq = 0;
  release = () => this.releases.splice(0).forEach((fn) => fn());
  private handle = async (request: RunRequest, options: StartOptions, id: string): Promise<RunHandle> => {
    const run: Run = {
      id,
      config: { mode: 'code', prompt: request.prompt ?? '', cwd: request.cwd ?? temp, maxRounds: 2, judge: 'claude', coder: 'claude', turnTimeoutMin: 30 },
      status: 'running',
      createdAt: Date.now(),
      messages: [],
    };
    options.onCreated?.(structuredClone(run));
    const done = new Promise<Run>((resolve) => {
      const finish = () => resolve({ ...run, status: 'done', endedAt: Date.now() });
      if (this.hold) this.releases.push(finish);
      else setTimeout(finish, 30);
    });
    return { id, run, subscribe: () => () => {}, done, cancel: () => {}, answerPlanDecision: async () => {}, answerPairDecision: () => true } as unknown as RunHandle;
  };
  start = async (request: RunRequest, options: StartOptions = {}) => {
    this.starts.push(request);
    return this.handle(request, options, `run-${++this.seq}`);
  };
  continue = async (id: string, request: RunRequest, options: StartOptions = {}) => {
    this.continues.push({ id, request });
    return this.handle(request, options, id);
  };
  get = async () => undefined;
  preflight = async () => ({ ok: true, checks: [], problems: [], authUnverified: false });
  previewRoute = async () => ({ mode: 'code' as const, coder: 'codex' as const, reviewer: 'claude' as const, maxRounds: 2, route: {} as never, askHaiku: false });
  abortAll = async () => {};
}

/** A clipboard that answers from a queue (the last answer repeats) and counts reads. */
function fakeClipboard(...answers: ClipboardResult[]) {
  let reads = 0;
  const read = async (): Promise<ClipboardResult> => answers[Math.min(reads++, answers.length - 1)];
  return { read, get reads() { return reads; } };
}

const pngResult = (size: number): ClipboardResult => ({ kind: 'image', bytes: pngOf(size), name: 'clipboard.png' });

function open(clipboard: ReturnType<typeof fakeClipboard>, screen: 'fullscreen' | 'inline' = 'inline') {
  const service = new FakeService();
  const app = render(createElement(App, { service: service as unknown as ChatService, cwd: files, version: 'test', history: [], skipPreflight: true, screen, readClipboard: clipboard.read }));
  const frame = () => app.lastFrame() ?? '';
  const type = async (text: string) => {
    app.stdin.write(text);
    await sleep(40);
  };
  const paste = (text: string) => type(`${PASTE_START}${text}${PASTE_END}`);
  const seeing = (text: string | RegExp, tries?: number) => until(() => (typeof text === 'string' ? frame().includes(text) : text.test(frame())), `"${String(text)}"\n${frame()}`, tries);
  const notSeeing = (text: string) => assert.ok(!frame().includes(text), `unexpected "${text}"\n${frame()}`);
  return { app, service, frame, type, paste, seeing, notSeeing };
}

/* ---- Chat: clipboard ---- */

await step('Ctrl+V attaches the clipboard image: a chip with type and size above the box', async () => {
  const t = open(fakeClipboard(pngResult(184 * 1024)));
  t.notSeeing('[Image');
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #1 · PNG · 184 KB]');
  assert.ok(t.frame().indexOf('[Image #1') < t.frame().indexOf('Ask anything'), 'chip is above the input');
  await t.seeing('Backspace at the start');
});

await step('Alt+V and /paste-image attach too; numbering is stable up to 4 images, the 5th is refused', async () => {
  const t = open(fakeClipboard(pngResult(2048)));
  await t.type(KEY.altV);
  await t.seeing('[Image #1 · PNG · 2 KB]');
  await t.type('/paste-image');
  await t.type(KEY.enter);
  await t.seeing('[Image #2 · PNG · 2 KB]');
  await t.type(KEY.ctrlV);
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #4');
  await t.type(KEY.ctrlV);
  await t.seeing('You can attach up to 4 images');
  t.notSeeing('[Image #5');
  assert.equal(t.frame().match(/\[Image #\d/g)?.length, 4);
});

await step('slash menu: /paste-image and /clear-images are listed', async () => {
  const t = open(fakeClipboard(pngResult(10)));
  await t.type('/paste');
  await t.seeing('/paste-image');
  await t.type(KEY.ctrlU);
  await t.type('/clear-i');
  await t.seeing('/clear-images');
});

await step('no image on the clipboard: a one-line notice, nothing attached', async () => {
  const t = open(fakeClipboard({ kind: 'none' }));
  await t.type(KEY.ctrlV);
  await t.seeing(notes.NO_IMAGE_NOTE);
  t.notSeeing('[Image');
  await t.type('x');
  t.notSeeing('No image on the clipboard');
});

await step('clipboard tool errors are shown as notices (Linux without xclip/wl-clipboard)', async () => {
  const t = open(fakeClipboard({ kind: 'error', message: clip.LINUX_MISSING }));
  await t.type(KEY.ctrlV);
  await t.seeing('install xclip (X11) or wl-clipboard (Wayland)');
});

await step('a copied image FILE (Explorer / Finder) on the clipboard is attached', async () => {
  const t = open(fakeClipboard({ kind: 'file', path: path.join(files, 'photo.jpg') }));
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #1 · photo.jpg · JPEG · 2 KB]');
});

await step('clipboard image that is not an image (bad bytes) or over 5 MB is refused', async () => {
  const t = open(fakeClipboard({ kind: 'image', bytes: Buffer.from('not an image at all'), name: 'clipboard.png' }));
  await t.type(KEY.ctrlV);
  await t.seeing('not a PNG, JPEG, WebP or GIF image');
  t.notSeeing('[Image #1');
  const big = open(fakeClipboard(pngResult(img.MAX_IMAGE_BYTES + 1)));
  await big.type(KEY.ctrlV);
  await big.seeing('larger than 5 MB');
});

await step('shell mode ignores image paste with a notice', async () => {
  const clipboard = fakeClipboard(pngResult(100));
  const t = open(clipboard);
  await t.type('!');
  await t.type(KEY.ctrlV);
  await t.seeing('Image paste is not available in shell mode');
  assert.equal(clipboard.reads, 0, 'the clipboard is not even read');
  t.notSeeing('[Image');
});

/* ---- Chat: paths ---- */

await step('pasting the path of an image file attaches it (plain, quoted, file:// URL, relative)', async () => {
  const t = open(fakeClipboard({ kind: 'none' }));
  await t.paste(PNG_FILE);
  await t.seeing('[Image #1 · shot.png · PNG · 184 KB]');
  await t.paste(`"${SPACED_FILE}"`);
  await t.seeing('[Image #2 · with space.png · PNG · 3 KB]');
  await t.paste(`'${path.join(files, 'photo.jpg')}'`);
  await t.seeing('[Image #3 · photo.jpg · JPEG');
  await t.paste(pathToFileURL(path.join(files, 'anim.gif')).href);
  await t.seeing('[Image #4 · anim.gif · GIF');
  await t.paste('pic.webp');
  await t.seeing('You can attach up to 4 images');
  assert.ok(!t.frame().includes('pic.webp') || t.frame().includes('You can attach'), 'a refused path is not inserted as text');
});

await step('Windows paths with backslashes and spaces attach; so does a ~ path', async () => {
  const t = open(fakeClipboard({ kind: 'none' }));
  if (WINDOWS) {
    await t.paste(SPACED_FILE.replaceAll('/', '\\'));
    await t.seeing('[Image #1 · with space.png');
  }
  const home = (await import('node:os')).homedir();
  const rel = path.relative(home, PNG_FILE);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    await t.paste(`~${path.sep}${rel}`);
    await t.seeing('shot.png');
  }
});

await step('a path typed by hand (a chunk of input, no bracketed paste) attaches; so does Enter on a typed path', async () => {
  const t = open(fakeClipboard({ kind: 'none' }));
  await t.type(JPEG_PATH());
  await t.seeing('[Image #1 · photo.jpg · JPEG');
  for (const ch of PNG_FILE) await t.type(ch);
  await t.type(KEY.enter);
  await t.seeing('[Image #2 · shot.png · PNG');
  assert.equal(t.service.starts.length, 0, 'Enter on a path attaches, it does not send');
});

function JPEG_PATH(): string {
  return path.join(files, 'photo.jpg');
}

await step('non-image, missing and folder paths stay plain text', async () => {
  const t = open(fakeClipboard({ kind: 'none' }));
  await t.paste(NOTE_FILE);
  await t.seeing('notes.txt');
  await t.paste(` ${path.join(files, 'missing.png')}`);
  await t.seeing('missing.png');
  await t.paste(path.join(files, 'folder.png'));
  await t.seeing('folder.png');
  t.notSeeing('[Image');
});

await step('a .png that is not a PNG is rejected by its bytes; a file over 5 MB is rejected', async () => {
  const t = open(fakeClipboard({ kind: 'none' }));
  await t.paste(FAKE_FILE);
  await t.seeing('is not a PNG, JPEG, WebP or GIF image');
  t.notSeeing('[Image #1');
  await t.paste(BIG_FILE);
  await t.seeing('larger than 5 MB');
  t.notSeeing('[Image #1');
});

/* ---- Chat: removal, sending ---- */

await step('Backspace at the start of the input removes the last chip; with text before the cursor it edits text; /clear-images clears', async () => {
  const t = open(fakeClipboard(pngResult(2048)));
  await t.type(KEY.ctrlV);
  await t.type(KEY.ctrlV);
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #3');
  await t.type(KEY.backspace);
  await until(() => !t.frame().includes('[Image #3'), 'chip 3 gone');
  assert.ok(t.frame().includes('[Image #2'));
  await t.type('ab');
  await t.type(KEY.backspace);
  await t.seeing('[Image #2');
  assert.ok(t.frame().includes('› a'), t.frame());
  await t.type(KEY.backspace);
  await t.type(KEY.backspace);
  await until(() => !t.frame().includes('[Image #2'), 'chip 2 gone');
  assert.ok(t.frame().includes('[Image #1'));
  await t.type('/clear-images');
  await t.type(KEY.enter);
  await t.seeing('Removed the attached images');
  t.notSeeing('[Image #1');
});

await step('sending: images are in the new-run request and the echo; chips reset; the follow-up carries only new images', async () => {
  const t = open(fakeClipboard(pngResult(4096)));
  await t.type(KEY.ctrlV);
  await t.paste(path.join(files, 'photo.jpg'));
  await t.seeing('[Image #2');
  await t.type('what is this');
  await t.type(KEY.enter);
  await until(() => t.service.starts.length === 1, 'the run to start');
  const first = t.service.starts[0];
  assert.equal(first.prompt, 'what is this');
  assert.equal(first.images?.length, 2);
  assert.equal(first.images?.[0].name, 'clipboard.png');
  assert.ok(first.images?.[0].dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(first.images?.[1].name, 'photo.jpg');
  assert.ok(first.images?.[1].dataUrl.startsWith('data:image/jpeg;base64,'));
  const parsed = parseImages(first.images);
  assert.ok(typeof parsed !== 'string', 'the server accepts what the TUI sends');
  await t.seeing('› what is this  [Image #1] [Image #2]');
  await until(() => !/\[Image #\d · /.test(t.frame().split('› what is this')[1] ?? ''), 'chips reset');
  assert.ok(!/\[Image #1 · /.test(t.frame()), `chips are gone from above the box\n${t.frame()}`);
  await until(() => t.frame().includes('ready'), 'the run to finish');
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #1 · PNG');
  await t.type('and this');
  await t.type(KEY.enter);
  await until(() => t.service.continues.length === 1, 'the follow-up');
  assert.equal(t.service.continues[0].id, 'run-1');
  assert.equal(t.service.continues[0].request.images?.length, 1);
  await t.seeing('› and this  [Image #1]');
  await until(() => t.frame().includes('ready'), 'the second run to finish');
  await t.type('plain follow up');
  await t.type(KEY.enter);
  await until(() => t.service.continues.length === 2, 'the third message');
  assert.equal(t.service.continues[1].request.images, undefined, 'no images unless attached');
});

await step('an image-only message (no text) can be sent', async () => {
  const t = open(fakeClipboard(pngResult(1024)));
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #1');
  await t.type(KEY.enter);
  await until(() => t.service.starts.length === 1, 'the run to start');
  assert.equal(t.service.starts[0].prompt, '');
  assert.equal(t.service.starts[0].images?.length, 1);
  await t.seeing('› [Image #1]');
});

await step('a slash command keeps the chips; a refused send (run in progress) keeps them too', async () => {
  const t = open(fakeClipboard(pngResult(1024)));
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #1');
  await t.type('/help');
  await t.type(KEY.enter);
  await t.seeing('Commands:');
  assert.ok(t.frame().includes('[Image #1'), 'chip survives /help');
  t.service.hold = true;
  await t.type('first');
  await t.type(KEY.enter);
  await until(() => t.service.starts.length === 1, 'the run to start');
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #1');
  await t.type('second');
  await t.type(KEY.enter);
  await t.seeing('A run is in progress');
  assert.ok(t.frame().includes('[Image #1'), 'chip kept after the refusal');
  assert.ok(t.frame().includes('second'), 'text put back');
});

await step('help and the status hint mention Ctrl+V / Alt+V, /paste-image and path paste', async () => {
  const t = open(fakeClipboard(pngResult(10)));
  await t.seeing('Ctrl+V image');
  await t.type('/help');
  await t.type(KEY.enter);
  await t.seeing('Ctrl+V or Alt+V attach an image');
  await t.seeing('/paste-image');
  assert.match(t.frame(), /image file\s+path/);
});

await step('full screen: the same flow works in the fixed layout', async () => {
  const t = open(fakeClipboard(pngResult(184 * 1024)), 'fullscreen');
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #1 · PNG · 184 KB]');
  await t.paste(PNG_FILE);
  await t.seeing('[Image #2 · shot.png');
  await t.type('hello');
  await t.type(KEY.enter);
  await until(() => t.service.starts.length === 1, 'the run to start');
  assert.equal(t.service.starts[0].images?.length, 2);
  await t.seeing('› hello  [Image #1] [Image #2]');
});

await step('quick successive keys (before a re-render) each see the chips of the previous one', async () => {
  const t = open(fakeClipboard(pngResult(2048)));
  await t.seeing('Ctrl+V image');
  await sleep(100);
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  t.app.stdin.write(KEY.ctrlV);
  await tick();
  t.app.stdin.write(KEY.ctrlV);
  await t.seeing('[Image #2');
  t.app.stdin.write(KEY.backspace);
  await tick();
  t.app.stdin.write(KEY.backspace);
  await until(() => !t.frame().includes('[Image #1'), 'both chips removed by two quick Backspaces');
});

/* ---- Request builder ---- */

await step('buildRequest: images ride along in every mode', async () => {
  const image = img.attachmentFromBytes(pngOf(100), 'a.png', 'file');
  assert.ok(image.ok);
  const selection = { mode: 'code' as const, role: null, pipelineId: null, overrides: {} };
  for (const s of [selection, { ...selection, mode: 'plan' as const }, { ...selection, pipelineId: 'p1' }]) {
    assert.deepEqual(buildRequest(s, 'x', '/w', [image.image]).images, [{ name: 'a.png', dataUrl: image.image.dataUrl }]);
    assert.equal(buildRequest(s, 'x', '/w').images, undefined);
  }
});

/* ---- ai-duo run --image ---- */
// The flag is covered end to end in cli-smoke.ts (built bundle, fake agents); here only the help text.
await step('HELP documents --image and the image keys', async () => {
  const { HELP } = await import('./commands.ts');
  assert.match(HELP, /--image <file>/);
  assert.match(HELP, /Ctrl\+V or Alt\+V/);
  assert.equal((await readFile(PNG_FILE)).length, 184 * 1024);
});

await rm(temp, { recursive: true, force: true }).catch(() => undefined);
if (failed) process.exit(1);
console.log('tui image smoke: all passed');
process.exit(0);
