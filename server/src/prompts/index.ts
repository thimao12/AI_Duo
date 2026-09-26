import { readFileSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../paths.ts';

export type PromptName = 'propose' | 'critique' | 'synthesize' | 'code' | 'review' | 'fix' | 'route';

/**
 * Fill a template from this folder. Templates are re-read on every call so they can
 * be tweaked without restarting. Single-pass replace: substituted values (which may
 * contain user text with `{{…}}`) are never expanded again.
 */
export function render(name: PromptName, vars: Record<string, string | number>): string {
  const tpl = readFileSync(path.join(paths.promptsDir, `${name}.md`), 'utf8');
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));
}
