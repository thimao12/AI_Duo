import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { settingsFile } from '../../../server/src/settings.ts';

export const MAX_HISTORY = 200;

/** Prompt history lives next to settings.json, in the app data folder. */
export const historyFile = (): string => path.join(path.dirname(settingsFile()), 'cli-history.json');

export async function loadHistory(file = historyFile()): Promise<string[]> {
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

export async function saveHistory(list: readonly string[], file = historyFile()): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(list.slice(-MAX_HISTORY)), 'utf8');
    await rename(tmp, file);
  } catch {
    // History is a convenience: a read-only data folder must not break the chat.
  }
}

/** Newest last; an entry equal to the previous one is not repeated. */
export function addToHistory(list: readonly string[], text: string): string[] {
  const entry = text.trim();
  if (!entry || list.at(-1) === entry) return [...list];
  return [...list, entry].slice(-MAX_HISTORY);
}
