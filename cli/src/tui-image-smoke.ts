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
const tok = await import('./tui/imageTokens.ts');
const ed = await import('./tui/editor.ts');
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

function attachment(size: number, source: 'clipboard' | 'file' = 'clipboard', name = 'clipboard.png') {
  const made = img.attachmentFromBytes(pngOf(size), name, source);
  assert.ok(made.ok);
  return made.image;
}

await step('attachmentLine / formatBytes / token helpers: numbering, renumbering, history text, token spans', async () => {
  const a = { num: 1, image: attachment(184 * 1024) };
  const b = { num: 3, image: attachment(3000, 'file', 'shot.png') };
  assert.equal(tok.attachmentLine(a), 'Image #1 PNG 184 KB');
  assert.equal(tok.attachmentLine(b), 'Image #3 shot.png PNG 3 KB');
  assert.equal(tok.attachmentSummary([b, a], 80), 'Image #1 PNG 184 KB · Image #3 shot.png PNG 3 KB');
  assert.equal(tok.attachmentSummary([a, b], 25), 'Image #1 PNG 184 KB', 'whole entries only');
  assert.equal(tok.attachmentSummary([a], 5), '', 'nothing when it does not fit');
  assert.equal(img.formatBytes(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(tok.nextNumber([a, b]), 2, 'the smallest free number');
  assert.equal(tok.nextNumber([]), 1);
  assert.deepEqual(tok.tokenSpans('x [Image #1] y [Image #2] [Image #3]', [a, b]).map((s) => s.num), [1, 3], 'tokens only for attachments');
  const sent = tok.renumberForSend('compare [Image #3] with [Image #1] and [Image #2]', [b, a]);
  assert.equal(sent.text, 'compare [Image #2] with [Image #1] and [Image #2]', 'a plain look-alike without attachment stays');
  assert.deepEqual(sent.images, [a.image, b.image], 'images in number order');
  assert.equal(tok.historyText('a [Image #1] b [Image #2]'), 'a [image] b [image]');
  assert.equal(tok.displayToken('[Image #1]'), '[Image #1]');
});

/* ---- editor.ts: tokens are atomic ---- */

const imgA = attachment(100);
const imgB = attachment(200);
/** Editor holding `text` with the given attachments; `at` is the cursor (default: the end). */
const withImages = (text: string, nums: number[], at = text.length): import('./tui/editor.ts').EditorState => ({
  text,
  cursor: at,
  images: nums.map((num) => ({ num, image: num === 2 ? imgB : imgA })),
});

await step('editor: insertImage puts the token at the cursor with a space unless whitespace/end follows; smallest free number; 4-image cap', async () => {
  const mid = ed.insertImage(withImages('describe this and compare', [], 14), imgA);
  assert.ok(mid);
  assert.equal(mid.text, 'describe this [Image #1] and compare');
  assert.equal(mid.cursor, 'describe this [Image #1] '.length);
  const atEnd = ed.insertImage({ text: 'hi ', cursor: 3 }, imgA);
  assert.equal(atEnd?.text, 'hi [Image #1]');
  assert.equal(atEnd?.cursor, 13);
  const beforeSpace = ed.insertImage({ text: 'a b', cursor: 1 }, imgA);
  assert.equal(beforeSpace?.text, 'a[Image #1] b');
  const hole = ed.insertImage(withImages('[Image #1] [Image #3]', [1, 3]), imgB);
  assert.equal(hole?.text, '[Image #1] [Image #3][Image #2]');
  const full = withImages('[Image #1][Image #2][Image #3][Image #4]', [1, 2, 3, 4]);
  assert.equal(ed.insertImage(full, imgA), undefined);
});

await step('editor: the cursor jumps over a token as one unit (arrows, Home/End, word jumps, vertical)', async () => {
  const text = 'a [Image #1] b';
  const s = withImages(text, [1], 2);
  assert.equal(ed.moveRight(s).cursor, 12, 'Right from the token start goes to its end');
  assert.equal(ed.moveLeft(withImages(text, [1], 12)).cursor, 2, 'Left from the token end goes to its start');
  assert.equal(ed.moveLeft(withImages(text, [1], 13)).cursor, 12);
  assert.equal(ed.wordRight(withImages(text, [1], 1)).cursor, 12);
  assert.equal(ed.wordLeft(withImages(text, [1], 12)).cursor, 2);
  assert.equal(ed.wordLeft(withImages(text, [1], 13)).cursor, 2, 'a word jump over the space and the token lands before the token');
  assert.equal(ed.lineStart(withImages(text, [1], 5)).cursor, 0, 'Home from a token is never inside');
  const lines = withImages('xxxxxxxx\nab [Image #1] cd', [1], 5);
  const down = ed.moveVertical(lines, 1);
  assert.ok(down);
  const spans = ed.spansOf(down);
  assert.ok(spans.every((sp) => !(sp.start < down.cursor && down.cursor < sp.end)), 'vertical move never lands inside a token');
  let walk = withImages(text, [1], 0);
  const seen = new Set<number>();
  for (let i = 0; i < 20; i++) {
    seen.add(walk.cursor);
    walk = ed.moveRight(walk);
  }
  for (let inside = 3; inside < 12; inside++) assert.ok(!seen.has(inside), `cursor never at ${inside}`);
});

await step('editor: Backspace and Delete next to a token remove the whole token and its attachment', async () => {
  const text = 'a [Image #1] b [Image #2]';
  const back = ed.backspace(withImages(text, [1, 2], 12));
  assert.equal(back.text, 'a  b [Image #2]');
  assert.equal(back.cursor, 2);
  assert.deepEqual(back.images?.map((i) => i.num), [2]);
  const del = ed.deleteForward(withImages(text, [1, 2], 2));
  assert.equal(del.text, 'a  b [Image #2]');
  assert.deepEqual(del.images?.map((i) => i.num), [2]);
  const last = ed.backspace(withImages(text, [1, 2], text.length));
  assert.equal(last.text, 'a [Image #1] b ');
  const none = ed.backspace(withImages('[Image #2]', [2]));
  assert.equal(none.text, '');
  assert.equal(none.images, undefined, 'no attachment is left behind');
  const plain = ed.backspace(withImages('x [Image #7]', [1], 12));
  assert.equal(plain.text, 'x [Image #7', 'a look-alike without attachment is plain text');
});

await step('editor: Ctrl+W / Ctrl+U / Ctrl+K / Alt+D that cut part of a token remove all of it and the attachment', async () => {
  const text = 'see [Image #1] now';
  const w = ed.deleteWordBack(withImages(text, [1], 14));
  assert.equal(w.text, 'see  now');
  assert.equal(w.images, undefined);
  const u = ed.deleteToLineStart(withImages(text, [1], 14));
  assert.equal(u.text, ' now');
  const k = ed.deleteToLineEnd(withImages(text, [1], 4));
  assert.equal(k.text, 'see ');
  assert.equal(k.images, undefined);
  const d = ed.deleteWordForward(withImages(text, [1], 3));
  assert.equal(d.text, 'see now');
  assert.equal(d.images, undefined);
  const keep = ed.deleteWordBack(withImages(text, [1], 18));
  assert.equal(keep.text, 'see [Image #1] ');
  assert.deepEqual(keep.images?.map((i) => i.num), [1]);
});

await step('editor: typing and reconciling: tokens come only from attachments; edits that drop a token drop the attachment', async () => {
  const typed = ed.insertText({ text: '', cursor: 0 }, '[Image #1]');
  assert.equal(typed.images, undefined);
  assert.equal(ed.spansOf(typed).length, 0);
  const keepTokens = ed.insertText(withImages('[Image #1]', [1]), ' more');
  assert.deepEqual(keepTokens.images?.map((i) => i.num), [1]);
  const replaced = ed.editorOf('plain text', withImages('[Image #1]', [1]).images);
  assert.equal(replaced.images, undefined, 'a history entry without the token drops the attachment');
  const stays = ed.editorOf('x [Image #2]', withImages('', [2]).images);
  assert.deepEqual(stays.images?.map((i) => i.num), [2]);
  const combining = ed.insertText(withImages('[Image #1]', [1]), '́');
  assert.deepEqual(combining.images?.map((i) => i.num), [1], 'a combining mark never merges into the token');
  const cleared = ed.clearImages(withImages('a [Image #1] b [Image #2]', [1, 2], 14));
  assert.equal(cleared.text, 'a  b ');
  assert.equal(cleared.cursor, 4);
  assert.equal(cleared.images, undefined);
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
  const frame = () => (app.lastFrame() ?? '').replaceAll('\u00a0', ' ');
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

const LEFT = '\u0002';
const UP = '\u001B[A';
const DOWN = '\u001B[B';
const DELETE = '\u001B[3~';

await step('Ctrl+V inserts [Image #1] INSIDE the input box (no chips row); a dim line lists the attachment', async () => {
  const t = open(fakeClipboard(pngResult(184 * 1024)));
  t.notSeeing('[Image');
  await t.type(KEY.ctrlV);
  await t.seeing('› [Image #1]');
  await t.seeing('Image #1 PNG 184 KB');
  assert.ok(!t.frame().includes('[Image #1 ·'), 'no chip label above the box');
  const lines = t.frame().split('\n');
  const tokenLine = lines.findIndex((l) => l.includes('› [Image #1]'));
  assert.ok(lines[tokenLine].includes('│'), 'the token is between the box borders');
  assert.ok(lines.findIndex((l) => l.includes('Image #1 PNG')) > tokenLine, 'the hint is below the box');
  t.notSeeing('Ask anything');
});

await step('the token goes in at the cursor, mid-text: "describe this [Image #1] and compare with [Image #2]"', async () => {
  const t = open(fakeClipboard(pngResult(2048)));
  await t.type('describe this and compare with ');
  for (let i = 0; i < 'and compare with '.length; i++) t.app.stdin.write(LEFT);
  await sleep(40);
  await t.type(KEY.altV);
  await t.seeing('› describe this [Image #1] and compare with');
  await t.type('x');
  await t.seeing('[Image #1] xand compare');
  await t.type(KEY.backspace);
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #2]');
});

await step('Alt+V and /paste-image attach too; numbers up to 4, the 5th is refused with a notice', async () => {
  const t = open(fakeClipboard(pngResult(2048)));
  await t.type('/paste-image');
  await t.type(KEY.enter);
  await t.seeing('› [Image #1]');
  await t.type(KEY.altV);
  await t.seeing('[Image #2]');
  await t.type(KEY.ctrlV);
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #4]');
  await t.type(KEY.ctrlV);
  await t.seeing('You can attach up to 4 images');
  t.notSeeing('[Image #5');
  assert.equal(t.frame().match(/\[Image #\d\]/g)?.length, 4);
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

await step('a copied image FILE (Explorer / Finder) on the clipboard is attached as a token', async () => {
  const t = open(fakeClipboard({ kind: 'file', path: path.join(files, 'photo.jpg') }));
  await t.type(KEY.ctrlV);
  await t.seeing('› [Image #1]');
  await t.seeing('Image #1 photo.jpg JPEG 2 KB');
});

await step('clipboard image that is not an image (bad bytes) or over 5 MB is refused', async () => {
  const t = open(fakeClipboard({ kind: 'image', bytes: Buffer.from('not an image at all'), name: 'clipboard.png' }));
  await t.type(KEY.ctrlV);
  await t.seeing('not a PNG, JPEG, WebP or GIF image');
  t.notSeeing('[Image #1');
  const big = open(fakeClipboard(pngResult(img.MAX_IMAGE_BYTES + 1)));
  await big.type(KEY.ctrlV);
  await big.seeing('larger than 5 MB');
  big.notSeeing('[Image #1');
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

await step('pasting the path of an image file inserts a token (plain, quoted, file:// URL, relative); the 5th is refused', async () => {
  const t = open(fakeClipboard({ kind: 'none' }));
  await t.paste(PNG_FILE);
  await t.seeing('› [Image #1]');
  await t.seeing('Image #1 shot.png PNG 184 KB');
  await t.paste(`"${SPACED_FILE}"`);
  await t.seeing('[Image #2]');
  await t.paste(`'${path.join(files, 'photo.jpg')}'`);
  await t.seeing('[Image #3]');
  await t.paste(pathToFileURL(path.join(files, 'anim.gif')).href);
  await t.seeing('[Image #4]');
  await t.paste('pic.webp');
  await t.seeing('You can attach up to 4 images');
  t.notSeeing('pic.webp');
});

await step('Windows paths with backslashes and spaces attach; so does a ~ path', async () => {
  const t = open(fakeClipboard({ kind: 'none' }));
  if (WINDOWS) {
    await t.paste(SPACED_FILE.replaceAll('/', '\\'));
    await t.seeing('[Image #1]');
    await t.seeing('with space.png');
  }
  const home = (await import('node:os')).homedir();
  const rel = path.relative(home, PNG_FILE);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    await t.paste(`~${path.sep}${rel}`);
    await t.seeing('shot.png');
  }
});

await step('a path typed by hand (a chunk of input) inserts a token; so does Enter on a typed lone path (no send)', async () => {
  const t = open(fakeClipboard({ kind: 'none' }));
  await t.type(path.join(files, 'photo.jpg'));
  await t.seeing('› [Image #1]');
  await t.seeing('Image #1 photo.jpg JPEG');
  const u = open(fakeClipboard({ kind: 'none' }));
  for (const ch of PNG_FILE) await u.type(ch);
  await u.type(KEY.enter);
  await u.seeing('› [Image #1]');
  await u.seeing('Image #1 shot.png PNG');
  assert.equal(u.service.starts.length, 0, 'Enter on a path attaches, it does not send');
  assert.ok(!u.frame().split('\n').some((l) => l.includes('›') && l.includes('shot.png')), 'the typed path text is replaced by the token');
});

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

/* ---- Chat: atomic tokens ---- */

await step('arrows jump over a token as one unit; Backspace after it and Delete before it remove the token and the attachment; /clear-images clears', async () => {
  const t = open(fakeClipboard(pngResult(2048)));
  await t.type('a ');
  await t.type(KEY.ctrlV);
  await t.type('b');
  await t.seeing('› a [Image #1]b');
  await t.type(LEFT);
  await t.type(LEFT);
  await t.type(DELETE);
  await t.seeing('› a b');
  t.notSeeing('[Image');
  t.notSeeing('Image #1 PNG');
  await t.type(KEY.ctrlV);
  await t.seeing('› a [Image #1] b');
  await t.type(KEY.backspace);
  await t.seeing('› a [Image #1]b');
  await t.type(KEY.backspace);
  await until(() => !t.frame().includes('[Image'), 'token deleted by the second Backspace');
  await t.seeing('› a b');
  await t.type(KEY.ctrlU);
  await t.type('\u000B');
  await t.type(KEY.ctrlV);
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #2]');
  await t.type('/clear-images');
  await t.type(KEY.enter);
  await t.seeing('Removed the attached images');
  t.notSeeing('[Image #');
  assert.equal(t.service.starts.length, 0, 'the command is not sent as a message');
});

await step('Ctrl+W over a token removes it whole; a typed look-alike without attachment is plain text', async () => {
  const t = open(fakeClipboard(pngResult(2048)));
  await t.type('see ');
  await t.type(KEY.ctrlV);
  await t.seeing('› see [Image #1]');
  await t.type('\u0017');
  await until(() => !t.frame().includes('[Image'), 'token deleted by Ctrl+W');
  await t.seeing('› see');
  t.notSeeing('Image #1 PNG');
  await t.type('[Image #9]');
  await t.seeing('[Image #9]');
  await t.type(KEY.backspace);
  await t.seeing('[Image #9');
  t.notSeeing('[Image #9]');
});

await step('long text with a token wraps without splitting the token', async () => {
  const t = open(fakeClipboard(pngResult(2048)));
  await t.type(`${'a'.repeat(86)} `);
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #1]');
  const lines = t.frame().split('\n');
  assert.ok(lines.every((l) => !/\[Image\s*│?\s*$/.test(l)), `token split across lines\n${t.frame()}`);
  assert.ok(lines.every((l) => !/^\W*#1\]/.test(l)), `token split across lines\n${t.frame()}`);
});

/* ---- Chat: sending ---- */

/** The line of the input box (the one with the prompt glyph inside the border). */
const inputLine = (t: { frame(): string }) => t.frame().split('\n').filter((l) => l.startsWith('│ ›')).join('\n');

const b64 = (size: number) => pngOf(size).toString('base64');

await step('sending keeps the tokens in the prompt, images go in number order; the box and hint reset; follow-up carries only new images', async () => {
  const t = open(fakeClipboard(pngResult(4096)));
  await t.type('compare ');
  await t.type(KEY.ctrlV);
  await t.type(' with ');
  await t.paste(path.join(files, 'photo.jpg'));
  await t.seeing('compare [Image #1] with [Image #2]');
  await t.type(KEY.enter);
  await until(() => t.service.starts.length === 1, 'the run to start');
  const first = t.service.starts[0];
  assert.equal(first.prompt, 'compare [Image #1] with [Image #2]');
  assert.equal(first.images?.length, 2);
  assert.equal(first.images?.[0].name, 'clipboard.png');
  assert.ok(first.images?.[0].dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(first.images?.[1].name, 'photo.jpg');
  assert.ok(first.images?.[1].dataUrl.startsWith('data:image/jpeg;base64,'));
  const parsed = parseImages(first.images);
  assert.ok(typeof parsed !== 'string', 'the server accepts what the TUI sends');
  await t.seeing('› compare [Image #1] with [Image #2]');
  await until(() => !t.frame().includes('Image #1 PNG'), 'the hint is gone after sending');
  await until(() => t.frame().includes('ready'), 'the run to finish');
  await t.type(KEY.ctrlV);
  await t.seeing('› [Image #1]');
  await t.type(' and this');
  await t.type(KEY.enter);
  await until(() => t.service.continues.length === 1, 'the follow-up');
  assert.equal(t.service.continues[0].id, 'run-1');
  assert.equal(t.service.continues[0].request.prompt, '[Image #1] and this');
  assert.equal(t.service.continues[0].request.images?.length, 1);
  await until(() => t.frame().includes('ready'), 'the second run to finish');
  await t.type('plain follow up');
  await t.type(KEY.enter);
  await until(() => t.service.continues.length === 2, 'the third message');
  assert.equal(t.service.continues[1].request.images, undefined, 'no images unless attached');
});

await step('renumbering on send: #2 deleted from #1,#2,#3 gives #1,#2 in the prompt and in the images array (new run and follow-up)', async () => {
  const t = open(fakeClipboard(pngResult(1000), pngResult(2000), pngResult(3000), pngResult(1000), pngResult(2000), pngResult(3000)));
  await t.type('x ');
  await t.type(KEY.ctrlV);
  await t.type(' y ');
  await t.type(KEY.ctrlV);
  await t.type(' z ');
  await t.type(KEY.ctrlV);
  await t.type(' w');
  await t.seeing('x [Image #1] y [Image #2] z [Image #3] w');
  for (let i = 0; i < 6; i++) t.app.stdin.write(LEFT);
  await sleep(40);
  await t.type(KEY.backspace);
  await t.seeing('x [Image #1] y  z [Image #3] w');
  await t.type(KEY.enter);
  await until(() => t.service.starts.length === 1, 'the run to start');
  const first = t.service.starts[0];
  assert.equal(first.prompt, 'x [Image #1] y  z [Image #2] w');
  assert.equal(first.images?.length, 2);
  assert.ok(first.images?.[0].dataUrl.endsWith(b64(1000)), 'image 1 is the first attachment');
  assert.ok(first.images?.[1].dataUrl.endsWith(b64(3000)), 'image 2 is the old #3');
  await t.seeing('› x [Image #1] y  z [Image #2] w');
  await until(() => t.frame().includes('ready'), 'the run to finish');
  await t.type(KEY.ctrlV);
  await t.type(KEY.ctrlV);
  await t.type(KEY.ctrlV);
  await t.seeing('[Image #3]');
  t.app.stdin.write(LEFT);
  t.app.stdin.write(KEY.backspace);
  await sleep(40);
  await t.type(KEY.enter);
  await until(() => t.service.continues.length === 1, 'the follow-up');
  const follow = t.service.continues[0].request;
  assert.equal(follow.images?.length, 2);
  assert.match(follow.prompt ?? '', /^\[Image #1\] ?\[Image #2\]$/);
});

await step('an image-only message (the token is the whole prompt) can be sent', async () => {
  const t = open(fakeClipboard(pngResult(1024)));
  await t.type(KEY.ctrlV);
  await t.seeing('› [Image #1]');
  await t.type(KEY.enter);
  await until(() => t.service.starts.length === 1, 'the run to start');
  assert.equal(t.service.starts[0].prompt, '[Image #1]');
  assert.equal(t.service.starts[0].images?.length, 1);
  await t.seeing('› [Image #1]');
});

await step('history: entries store [image] instead of tokens; Up/Down bring the unsent draft back with its attachments', async () => {
  const t = open(fakeClipboard(pngResult(1024)));
  await t.type('look ');
  await t.type(KEY.ctrlV);
  await t.type(KEY.enter);
  await until(() => t.service.starts.length === 1, 'the run to start');
  assert.equal(t.service.starts[0].images?.length, 1);
  await until(() => t.frame().includes('ready'), 'the run to finish');
  await t.type('my draft ');
  await t.type(KEY.ctrlV);
  await t.seeing('› my draft [Image #1]');
  await t.type(UP);
  await t.seeing('› look [image]');
  t.notSeeing('Image #1 PNG');
  assert.ok(!inputLine(t).includes('[Image #1]'), 'the recalled entry has no token');
  await t.type(DOWN);
  await t.seeing('› my draft [Image #1]');
  await t.seeing('Image #1 PNG');
  await t.type(UP);
  await t.seeing('› look [image]');
  await t.type(KEY.enter);
  await until(() => t.service.continues.length === 1, 'the history message');
  assert.equal(t.service.continues[0].request.prompt, 'look [image]');
  assert.equal(t.service.continues[0].request.images, undefined, 'a recalled entry never resurrects an attachment');
  await until(() => t.frame().includes('ready'), 'the run to finish');
  await t.type(KEY.ctrlV);
  await t.type(' compare');
  await t.type(UP);
  await t.type(DOWN);
  await t.type(KEY.enter);
  await until(() => t.service.continues.length === 2, 'the draft message');
  assert.equal(t.service.continues[1].request.prompt, '[Image #1] compare');
  assert.equal(t.service.continues[1].request.images?.length, 1);
});

await step('a refused send (run in progress) keeps the text, the tokens and the attachments', async () => {
  const t = open(fakeClipboard(pngResult(1024)));
  t.service.hold = true;
  await t.type('first');
  await t.type(KEY.enter);
  await until(() => t.service.starts.length === 1, 'the run to start');
  await t.type('second ');
  await t.type(KEY.ctrlV);
  await t.seeing('› second [Image #1]');
  await t.type(KEY.enter);
  await t.seeing('A run is in progress');
  await t.seeing('› second [Image #1]');
  t.service.hold = false;
  t.service.release();
});

await step('help and the status hint mention Ctrl+V / Alt+V, /paste-image, path paste and the tokens', async () => {
  const t = open(fakeClipboard(pngResult(10)));
  await t.seeing('Ctrl+V image');
  await t.type('/help');
  await t.type(KEY.enter);
  await t.seeing('Ctrl+V or Alt+V attach an image');
  await t.seeing('/paste-image');
  await t.seeing('[Image #1]');
  assert.match(t.frame(), /image file\s+path/);
  assert.ok(!t.frame().includes('Backspace at the start'), 'the old chip behaviour is gone from the help');
});

await step('full screen: the same flow works in the fixed layout', async () => {
  const t = open(fakeClipboard(pngResult(184 * 1024)), 'fullscreen');
  await t.type('hello ');
  await t.type(KEY.ctrlV);
  await t.seeing('› hello [Image #1]');
  await t.type(' and ');
  await t.paste(PNG_FILE);
  await t.seeing('[Image #2]');
  await t.type(KEY.enter);
  await until(() => t.service.starts.length === 1, 'the run to start');
  assert.equal(t.service.starts[0].images?.length, 2);
  assert.equal(t.service.starts[0].prompt, 'hello [Image #1] and [Image #2]');
  await t.seeing('› hello [Image #1] and [Image #2]');
});

await step('quick successive keys (before a re-render) each see the tokens of the previous one', async () => {
  const t = open(fakeClipboard(pngResult(2048)));
  await t.seeing('Ctrl+V image');
  await sleep(100);
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  t.app.stdin.write(KEY.ctrlV);
  await tick();
  t.app.stdin.write(KEY.ctrlV);
  await t.seeing('[Image #2]');
  t.app.stdin.write(KEY.backspace);
  await tick();
  t.app.stdin.write(KEY.backspace);
  await until(() => !t.frame().includes('[Image #'), 'both tokens removed by two quick Backspaces');
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
