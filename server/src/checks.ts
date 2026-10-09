import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { authorizeDirectory } from './project-directories.ts';

interface Check {
  name: string;
  command: string;
  args: string[];
}

const CHECK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4_000;

const has = (cwd: string, ...files: string[]) => files.some((f) => existsSync(path.join(cwd, f)));

function hasDependency(cwd: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
  } catch {
    return false;
  }
}

/** The static checks a project has configured (TypeScript, Biome, ESLint, Ruff), cheapest signal first. */
export function detectChecks(cwd: string): Check[] {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const checks: Check[] = [];
  if (has(cwd, 'tsconfig.json') && hasDependency(cwd, 'typescript')) checks.push({ name: 'tsc', command: npx, args: ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'] });
  if (has(cwd, 'biome.json', 'biome.jsonc')) checks.push({ name: 'biome', command: npx, args: ['--no-install', 'biome', 'check', '--colors=off', '.'] });
  else if (has(cwd, 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs')) checks.push({ name: 'eslint', command: npx, args: ['--no-install', 'eslint', '--no-color', '.'] });
  if (has(cwd, 'ruff.toml', '.ruff.toml') || (has(cwd, 'pyproject.toml') && /\[tool\.ruff/.test(readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8')))) checks.push({ name: 'ruff', command: 'ruff', args: ['check', '--no-cache', '.'] });
  return checks;
}

function run(cwd: string, check: Check, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' && check.command.endsWith('.cmd');
    execFile(check.command, check.args, { cwd, shell, timeout: CHECK_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() });
    });
  });
}

/** Keeps the start of the output: compiler and linter errors come first and later ones are usually follow-ons. */
function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[... cắt bớt ${text.length - MAX_OUTPUT_CHARS} ký tự ...]` : text;
}

/**
 * Runs the project's own static checks and reports only the failures, so a reviewer can skip
 * re-deriving them. Empty when nothing is configured; "pass" when every check is clean.
 */
export async function runChecks(cwd: string, signal?: AbortSignal): Promise<{ passed: boolean; report: string }> {
  const dir = path.resolve(authorizeDirectory(cwd));
  const checks = detectChecks(dir);
  if (!checks.length) return { passed: true, report: '' };
  const results = await Promise.all(checks.map(async (c) => ({ c, ...(await run(dir, c, signal)) })));
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return { passed: true, report: `Kiểm tra tĩnh (${checks.map((c) => c.name).join(', ')}): không có lỗi.` };
  return { passed: false, report: failed.map((r) => `### ${r.c.name} — LỖI\n${clip(r.output)}`).join('\n\n') };
}
