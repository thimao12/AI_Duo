import { exec } from 'node:child_process';
import { getCliSettingsSync } from './settings.ts';
import type { HookName } from './types.ts';

const HOOK_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 2000;

export interface HookResult {
  ok: boolean;
  output: string;
}

/**
 * Runs the hook saved for `name` in `cwd` through the shell, with the turn described in
 * AI_DUO_* variables. Resolves to undefined when none is configured; never rejects.
 */
export function runHook(name: HookName, cwd: string, context: Record<string, string>, signal?: AbortSignal): Promise<HookResult | undefined> {
  const command = getCliSettingsSync().hooks?.[name];
  if (!command) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const env = { ...process.env, ...Object.fromEntries(Object.entries(context).map(([k, v]) => [`AI_DUO_${k.toUpperCase()}`, v])), AI_DUO_HOOK: name };
    exec(command, { cwd, env, timeout: HOOK_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, signal }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      resolve({ ok: !err, output: output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}…` : output });
    });
  });
}

/** Tool calls that write files: Claude's Edit family and Write, Codex's file changes. */
const EDIT_TOOL = /^(Edit|MultiEdit|Write|NotebookEdit|Edit files)\b/;

/** Whether a turn's parts contain a file edit (what the afterEdit hook waits for). */
export const editedFiles = (parts: readonly { kind: string; content: string; edit?: unknown }[]): boolean =>
  parts.some((p) => p.kind === 'tool' && (p.edit !== undefined || EDIT_TOOL.test(p.content)));
