import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findExecutable } from '../../../shared/exe.ts';
import { MAX_IMAGE_BYTES } from './images.ts';

/** What the OS clipboard holds, as far as an image goes. */
export type ClipboardResult =
  | { kind: 'image'; bytes: Buffer; name: string }
  /** An image FILE was copied (Explorer, Finder): the caller loads it like a pasted path. */
  | { kind: 'file'; path: string }
  | { kind: 'none' }
  | { kind: 'error'; message: string };

export type ClipboardReader = () => Promise<ClipboardResult>;

export interface RunOutput {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  /** The output went over the 5 MB cap; the process was killed. */
  overflow: boolean;
  /** The executable could not be started. */
  spawnError?: string;
}

/** Runs one executable (absolute path) with a fixed argument list and the given extra environment. */
export type ClipboardRunner = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<RunOutput>;

export interface ClipboardDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  find?: (name: string) => string | undefined;
  exists?: (file: string) => boolean;
  run?: ClipboardRunner;
  /** Pause before the single retry when the Windows clipboard is busy. */
  retryDelayMs?: number;
}

export const CLIPBOARD_TIMEOUT_MS = 5000;
/** Environment variable that carries the private output folder to the fixed scripts (no user data in the command text). */
export const OUT_DIR_ENV = 'AIDUO_CLIP_DIR';
const OUT_FILE = 'clip.png';

export const LINUX_MISSING = 'Cannot read the clipboard: install xclip (X11) or wl-clipboard (Wayland).';
const NO_IMAGE: ClipboardResult = { kind: 'none' };

/* ---- Fixed command texts ---- */

/** Windows: saves the clipboard bitmap as PNG into the output folder, or names the first copied image file. */
export const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'try { Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$img = [System.Windows.Forms.Clipboard]::GetImage()',
  "if ($null -ne $img) { $img.Save((Join-Path $env:AIDUO_CLIP_DIR 'clip.png'), [System.Drawing.Imaging.ImageFormat]::Png); $img.Dispose(); 'IMAGE'; exit 0 }",
  '$list = [System.Windows.Forms.Clipboard]::GetFileDropList()',
  String.raw`foreach ($f in $list) { if ($f -match '\.(png|jpe?g|webp|gif)$') { 'FILE:' + $f; exit 0 } }`,
  "'NONE'; exit 0 } catch { if ($_.Exception -is [System.Runtime.InteropServices.ExternalException]) { 'BUSY' } else { 'ERROR:' + $_.Exception.Message }; exit 0 }",
].join('; ');

const MAC_SCRIPT_LINES = [
  'try',
  'set png to the clipboard as «class PNGf»',
  'on error',
  'return "NONE"',
  'end try',
  'set outPath to (system attribute "AIDUO_CLIP_DIR") & "/clip.png"',
  'set fileRef to open for access (POSIX file outPath) with write permission',
  'set eof of fileRef to 0',
  'write png to fileRef',
  'close access fileRef',
  'return "IMAGE"',
];

const WINDOWS_ARGS = ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_SCRIPT];
const MAC_ARGS = MAC_SCRIPT_LINES.flatMap((line) => ['-e', line]);

/* ---- Default runner ---- */

/** Spawns without a shell, stdin ignored, 5 s timeout, output capped at 5 MB; the process is always reaped. */
export const runProcess: ClipboardRunner = (file, args, env) =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (out: Partial<RunOutput>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout: Buffer.concat(chunks), stderr, timedOut, overflow, ...out });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CLIPBOARD_TIMEOUT_MS);
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, windowsHide: true });
    } catch (err) {
      finish({ spawnError: (err as Error).message });
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES + 1) {
        overflow = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => finish({ spawnError: err.message }));
    child.on('close', (code) => finish({ code }));
  });

/* ---- Per platform ---- */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0].trim();

function failure(out: RunOutput, what: string): ClipboardResult | undefined {
  if (out.spawnError) return { kind: 'error', message: `Cannot read the clipboard: ${what} could not start.` };
  if (out.timedOut) return { kind: 'error', message: 'Reading the clipboard timed out.' };
  if (out.overflow) return { kind: 'error', message: 'The clipboard image is larger than 5 MB.' };
  return undefined;
}

async function readOutFile(dir: string): Promise<ClipboardResult> {
  const file = path.join(dir, OUT_FILE);
  try {
    const info = await stat(file);
    if (info.size > MAX_IMAGE_BYTES) return { kind: 'error', message: 'The clipboard image is larger than 5 MB.' };
    return { kind: 'image', bytes: await readFile(file), name: 'clipboard.png' };
  } catch {
    return { kind: 'error', message: 'The clipboard image could not be read.' };
  }
}

/** The Windows script's reply (first stdout line) as a result; 'BUSY' means retry. */
export function parseWindowsReply(reply: string): ClipboardResult | 'BUSY' | 'IMAGE' {
  if (reply === 'IMAGE') return 'IMAGE';
  if (reply === 'BUSY') return 'BUSY';
  if (reply.startsWith('FILE:')) return { kind: 'file', path: reply.slice(5) };
  if (reply.startsWith('ERROR:')) return { kind: 'error', message: `Cannot read the clipboard: ${reply.slice(6)}` };
  return NO_IMAGE;
}

function windowsShell(deps: Required<Pick<ClipboardDeps, 'env' | 'find' | 'exists'>>): string | undefined {
  const root = deps.env.SystemRoot ?? deps.env.SYSTEMROOT;
  if (root && path.win32.isAbsolute(root)) {
    const builtin = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (deps.exists(builtin)) return builtin;
  }
  return deps.find('pwsh');
}

async function readWindows(dir: string, run: ClipboardRunner, shell: string, retryDelayMs: number, retried = false): Promise<ClipboardResult> {
  const out = await run(shell, WINDOWS_ARGS, { [OUT_DIR_ENV]: dir });
  const failed = failure(out, 'PowerShell');
  if (failed) return failed;
  const reply = parseWindowsReply(firstLine(out.stdout.toString('utf8')));
  if (reply === 'IMAGE') return readOutFile(dir);
  if (reply !== 'BUSY') return reply;
  if (retried) return { kind: 'error', message: 'The clipboard is busy; try again.' };
  await sleep(retryDelayMs);
  return readWindows(dir, run, shell, retryDelayMs, true);
}

async function readMac(dir: string, run: ClipboardRunner, deps: Required<Pick<ClipboardDeps, 'find' | 'exists'>>): Promise<ClipboardResult> {
  const pngpaste = [deps.find('pngpaste'), '/opt/homebrew/bin/pngpaste', '/usr/local/bin/pngpaste'].find((file) => file && deps.exists(file));
  if (pngpaste) {
    const out = await run(pngpaste, [path.join(dir, OUT_FILE)], {});
    const failed = failure(out, 'pngpaste');
    if (failed) return failed;
    return out.code === 0 ? readOutFile(dir) : NO_IMAGE;
  }
  const osascript = '/usr/bin/osascript';
  if (!deps.exists(osascript)) return { kind: 'error', message: 'Cannot read the clipboard: osascript was not found.' };
  const out = await run(osascript, MAC_ARGS, { [OUT_DIR_ENV]: dir });
  const failed = failure(out, 'osascript');
  if (failed) return failed;
  return firstLine(out.stdout.toString('utf8')) === 'IMAGE' ? readOutFile(dir) : NO_IMAGE;
}

const DISPLAY_PROBLEM = /can't open display|cannot open display|failed to connect|no wayland|compositor/i;

/** wl-paste on Wayland, xclip on X11: whichever exists (the one matching the session first). */
function linuxTool(deps: Required<Pick<ClipboardDeps, 'env' | 'find'>>): { file: string; args: string[]; name: string } | undefined {
  const wayland = deps.find('wl-paste');
  const x11 = deps.find('xclip');
  const wlTool = wayland && { file: wayland, args: ['--type', 'image/png'], name: 'wl-paste' };
  const xTool = x11 && { file: x11, args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], name: 'xclip' };
  const preferWayland = Boolean(deps.env.WAYLAND_DISPLAY);
  return (preferWayland ? wlTool || xTool : xTool || wlTool) || undefined;
}

async function readLinux(run: ClipboardRunner, tool: { file: string; args: string[]; name: string }): Promise<ClipboardResult> {
  const out = await run(tool.file, tool.args, {});
  const failed = failure(out, tool.name);
  if (failed) return failed;
  if (out.code !== 0) return DISPLAY_PROBLEM.test(out.stderr) ? { kind: 'error', message: `Cannot read the clipboard: ${firstLine(out.stderr)}` } : NO_IMAGE;
  return out.stdout.length > 0 ? { kind: 'image', bytes: out.stdout, name: 'clipboard.png' } : NO_IMAGE;
}

/**
 * Reads an image (or a copied image file) from the OS clipboard. Executables are absolute paths only;
 * the commands are constants. A private temp folder is used while reading and always removed.
 */
export async function readClipboardImage(deps: ClipboardDeps = {}): Promise<ClipboardResult> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const find = deps.find ?? findExecutable;
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? runProcess;
  if (platform === 'linux' || platform === 'freebsd') {
    const tool = linuxTool({ env, find });
    return tool ? readLinux(run, tool) : { kind: 'error', message: LINUX_MISSING };
  }
  const shell = platform === 'win32' ? windowsShell({ env, find, exists }) : undefined;
  if (platform === 'win32' && !shell) return { kind: 'error', message: 'Cannot read the clipboard: PowerShell was not found.' };
  if (platform !== 'win32' && platform !== 'darwin') return { kind: 'error', message: `Image paste is not supported on ${platform}.` };
  const dir = await mkdtemp(path.join(tmpdir(), 'aiduo-clip-'));
  try {
    if (shell) return await readWindows(dir, run, shell, deps.retryDelayMs ?? 250);
    return await readMac(dir, run, { find, exists });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
