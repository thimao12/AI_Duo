import { statSync } from 'node:fs';
import path from 'node:path';
import { effortNameProblem, modelNameProblem } from './models.ts';
import type { CliConfig, CliSettings } from './types.ts';

/** Validation of the per-CLI manual configuration; pure apart from checking that binPath is a file. */

export const MAX_EXTRA_ARGS = 50;
export const MAX_ARG_LENGTH = 500;
export const MAX_ENV_KEYS = 50;
export const MAX_ENV_VALUE = 2000;
export const MAX_TEST_COMMAND = 500;
export const MAX_TURN_TIMEOUT_MIN = 240;
const ENV_KEY = /^[A-Za-z_]\w{0,63}$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Flags AI Duo sets itself to enforce read/edit permissions; extra arguments may not repeat them. */
const PROTECTED_FLAGS = [
  '--permission-mode',
  '--allowedtools',
  '--allowed-tools',
  '--disallowedtools',
  '--disallowed-tools',
  '--tools',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--sandbox',
  '-s',
  '--dangerously-bypass-approvals-and-sandbox',
  '--full-auto',
  '--ask-for-approval',
  '--yolo',
];
/** `-c sandbox_mode=...` would override the sandbox that AI Duo passes the same way. */
const PROTECTED_CONFIG_KEYS = ['sandbox_mode', 'approval_policy', 'sandbox_permissions'];

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasNul = (value: string) => value.includes('\0');

export const emptyCliSettings = (): CliSettings => ({ claude: {}, codex: {} });

function binPathProblem(value: string, label: string): string | undefined {
  if (hasNul(value) || !path.isAbsolute(value)) return `${label} phải là đường dẫn tuyệt đối tới file chạy được.`;
  try {
    if (statSync(value).isFile()) return undefined;
  } catch {
    // reported below
  }
  return `${label}: không tìm thấy file "${value}".`;
}

function protectedArg(arg: string): boolean {
  const lower = arg.toLowerCase();
  if (PROTECTED_FLAGS.some((flag) => lower === flag || lower.startsWith(flag))) return true;
  return PROTECTED_CONFIG_KEYS.some((key) => lower.includes(key));
}

function extraArgsProblem(value: unknown, label: string): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_EXTRA_ARGS) return `${label} phải là danh sách tối đa ${MAX_EXTRA_ARGS} chuỗi.`;
  for (const [index, arg] of value.entries()) {
    const at = `${label}[${index}]`;
    if (typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || hasNul(arg)) return `${at} phải là chuỗi tối đa ${MAX_ARG_LENGTH} ký tự, không chứa ký tự NUL.`;
    if (protectedArg(arg)) return `${at} ("${arg}") không được phép: AI Duo tự đặt quyền và sandbox của CLI.`;
  }
  return undefined;
}

function envProblem(value: unknown, label: string): string | undefined {
  if (!isObj(value)) return `${label} phải là một đối tượng tên biến -> giá trị.`;
  const entries = Object.entries(value);
  if (entries.length > MAX_ENV_KEYS) return `${label} có tối đa ${MAX_ENV_KEYS} biến.`;
  for (const [key, item] of entries) {
    if (!ENV_KEY.test(key) || FORBIDDEN_KEYS.has(key)) return `${label}: tên biến "${key}" không hợp lệ (dùng chữ, số, gạch dưới, không bắt đầu bằng số).`;
    if (typeof item !== 'string' || item.length > MAX_ENV_VALUE || hasNul(item)) return `${label}.${key} phải là chuỗi tối đa ${MAX_ENV_VALUE} ký tự, không chứa ký tự NUL.`;
  }
  return undefined;
}

function cleanCli(input: Obj): CliConfig {
  const config: CliConfig = {};
  const binPath = typeof input.binPath === 'string' ? input.binPath.trim() : '';
  if (binPath) config.binPath = binPath;
  if (Array.isArray(input.extraArgs) && input.extraArgs.length) config.extraArgs = [...input.extraArgs] as string[];
  if (isObj(input.env) && Object.keys(input.env).length) config.env = { ...input.env } as Record<string, string>;
  for (const key of ['defaultModel', 'defaultEffort'] as const) {
    const value = input[key];
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) config[key] = text;
  }
  return config;
}

function binProblem(binPath: unknown, label: string, checkFile: boolean): string | undefined {
  if (binPath === undefined || binPath === null) return undefined;
  if (typeof binPath !== 'string') return `${label}.binPath phải là chuỗi.`;
  const value = binPath.trim();
  if (!value) return undefined;
  return checkFile ? binPathProblem(value, `${label}.binPath`) : undefined;
}

function cliProblem(input: unknown, label: string, checkFile: boolean): CliConfig | string {
  if (input === undefined || input === null) return {};
  if (!isObj(input)) return `${label} phải là một đối tượng.`;
  const problem =
    binProblem(input.binPath, label, checkFile) ??
    (input.extraArgs === undefined ? undefined : extraArgsProblem(input.extraArgs, `${label}.extraArgs`)) ??
    (input.env === undefined ? undefined : envProblem(input.env, `${label}.env`)) ??
    modelNameProblem(input.defaultModel, `${label}.defaultModel`) ??
    effortNameProblem(input.defaultEffort, `${label}.defaultEffort`);
  return problem ?? cleanCli(input);
}

function testCommandProblem(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > MAX_TEST_COMMAND || hasNul(value)) return `testCommand phải là chuỗi tối đa ${MAX_TEST_COMMAND} ký tự, không chứa ký tự NUL.`;
  return undefined;
}

function timeoutProblem(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const ok = typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TURN_TIMEOUT_MIN;
  return ok ? undefined : `turnTimeoutMin phải là số nguyên từ 1 đến ${MAX_TURN_TIMEOUT_MIN}.`;
}

/** The cleaned settings (empty values dropped), or the first problem found (in Vietnamese). */
export function validateCliSettings(input: unknown, checkFile = true): CliSettings | string {
  if (!isObj(input)) return 'cli phải là một đối tượng.';
  const claude = cliProblem(input.claude, 'claude', checkFile);
  if (typeof claude === 'string') return claude;
  const codex = cliProblem(input.codex, 'codex', checkFile);
  if (typeof codex === 'string') return codex;
  const problem = timeoutProblem(input.turnTimeoutMin) ?? testCommandProblem(input.testCommand);
  if (problem) return problem;
  const settings: CliSettings = { claude, codex };
  if (typeof input.turnTimeoutMin === 'number') settings.turnTimeoutMin = input.turnTimeoutMin;
  const testCommand = typeof input.testCommand === 'string' ? input.testCommand.trim() : '';
  if (testCommand) settings.testCommand = testCommand;
  return settings;
}

/** Lenient read of a stored file (a binPath that vanished is kept; launching it fails clearly): an invalid `cli` falls back to the defaults instead of failing to load. */
export function loadCliSettings(input: unknown): CliSettings {
  const checked = validateCliSettings(input, false);
  return typeof checked === 'string' ? emptyCliSettings() : checked;
}
