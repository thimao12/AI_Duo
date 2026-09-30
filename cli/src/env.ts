import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { appDataRoot } from '../../server/src/app-data.ts';

/**
 * Imported first by main.ts: the server modules read these variables when they load. Like the
 * desktop app, the CLI keeps runs and editable prompts in the shared app-data folder.
 */
process.env.AI_DUO_DATA_DIR ||= path.join(appDataRoot(), 'runs');
process.env.AI_DUO_PROMPTS_DIR ||= path.join(appDataRoot(), 'prompts');
process.env.AI_DUO_DEFAULT_CWD ||= invocationCwd();

const here = import.meta.dirname;
// Bundle: dist/prompts next to ai-duo.mjs. Source checkout (pnpm --filter ai-duo-cli dev): server/src/prompts.
const bundledPrompts = [path.join(here, 'prompts'), path.resolve(here, '../../server/src/prompts')].find((dir) => existsSync(dir));

/** Copy only missing templates, so prompts the user edited are never overwritten. */
export async function seedPrompts(target = process.env.AI_DUO_PROMPTS_DIR!) {
  if (!bundledPrompts) throw new Error(`Prompt templates not found next to ${here}; reinstall or rebuild the CLI.`);
  await mkdir(target, { recursive: true });
  const names = (await readdir(bundledPrompts)).filter((name) => name.endsWith('.md'));
  await Promise.all(names.map(async (name) => {
    const to = path.join(target, name);
    if (!existsSync(to)) await copyFile(path.join(bundledPrompts, name), to);
  }));
}

/** Where `ai-duo` was typed; pnpm scripts run inside cli/ and keep the original folder in INIT_CWD. */
export function invocationCwd() {
  return process.env.npm_package_name === 'ai-duo-cli' && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd();
}
