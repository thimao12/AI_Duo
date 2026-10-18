import { statSync } from 'node:fs';
import path from 'node:path';
import { effortNameProblem, modelNameProblem } from './models.ts';
import type { CliConfig, CliSettings, HookName, McpServer } from './types.ts';

/** Validation of the per-CLI manual configuration; pure apart from checking that binPath is a file. */

export const MAX_EXTRA_ARGS = 50;
export const MAX_ARG_LENGTH = 500;
export const MAX_ENV_KEYS = 50;
export const MAX_ENV_VALUE = 2000;
export const MAX_TEST_COMMAND = 500;
export const MAX_TURN_TIMEOUT_MIN = 240;
const MAX_MCP_SERVERS = 20;
const THEME_ID = /^[a-z0-9-]{1,32}$/;
const MCP_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const MCP_ROLES: readonly string[] = ['coder', 'reviewer', 'thinker'];
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
/**
 * Antigravity: AI Duo sets the mode (plan / accept-edits), the stream-json formats, the conversation and the
 * prompt. Matched as the flag itself or `--flag=value` (a short flag also with its value attached).
 */
const AGENT_PROTECTED_FLAGS: Partial<Record<keyof CliSettings, readonly string[]>> = {
  antigravity: ['--mode', '--approval-mode', '--input-format', '--output-format', '--conversation', '--resume', '--continue', '--prompt', '--prompt-interactive', '--print', '-p', '-o', '-r', '-y'],
};

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasNul = (value: string) => value.includes('\0');

export const emptyCliSettings = (): CliSettings => ({ claude: {}, codex: {}, antigravity: {} });

function binPathProblem(value: string, label: string): string | undefined {
  if (hasNul(value) || !path.isAbsolute(value)) return `${label} phải là đường dẫn tuyệt đối tới file chạy được.`;
  try {
    if (statSync(value).isFile()) return undefined;
  } catch {
    // reported below
  }
  return `${label}: không tìm thấy file "${value}".`;
}

function agentFlag(lower: string, flag: string): boolean {
  if (lower === flag || lower.startsWith(`${flag}=`)) return true;
  return !flag.startsWith('--') && lower.startsWith(flag);
}

function protectedArg(arg: string, agent?: string): boolean {
  const lower = arg.toLowerCase();
  if (PROTECTED_FLAGS.some((flag) => lower === flag || lower.startsWith(flag))) return true;
  if ((AGENT_PROTECTED_FLAGS[agent as keyof CliSettings] ?? []).some((flag) => agentFlag(lower, flag))) return true;
  return PROTECTED_CONFIG_KEYS.some((key) => lower.includes(key));
}

function extraArgsProblem(value: unknown, label: string, agent?: string): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_EXTRA_ARGS) return `${label} phải là danh sách tối đa ${MAX_EXTRA_ARGS} chuỗi.`;
  for (const [index, arg] of value.entries()) {
    const at = `${label}[${index}]`;
    if (typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || hasNul(arg)) return `${at} phải là chuỗi tối đa ${MAX_ARG_LENGTH} ký tự, không chứa ký tự NUL.`;
    if (protectedArg(arg, agent)) return `${at} ("${arg}") không được phép: AI Duo tự đặt quyền, chế độ, định dạng vào/ra, hội thoại và prompt của CLI.`;
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
    (input.extraArgs === undefined ? undefined : extraArgsProblem(input.extraArgs, `${label}.extraArgs`, label)) ??
    (input.env === undefined ? undefined : envProblem(input.env, `${label}.env`)) ??
    modelNameProblem(input.defaultModel, `${label}.defaultModel`) ??
    effortNameProblem(input.defaultEffort, `${label}.defaultEffort`);
  return problem ?? cleanCli(input);
}

function mcpProblem(value: unknown): McpServer[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_MCP_SERVERS) return `mcp phải là danh sách tối đa ${MAX_MCP_SERVERS} server.`;
  const servers: McpServer[] = [];
  for (const [index, item] of value.entries()) {
    const at = `mcp[${index}]`;
    if (!isObj(item)) return `${at} phải là một đối tượng.`;
    if (typeof item.name !== 'string' || !MCP_NAME.test(item.name)) return `${at}.name chỉ gồm chữ, số, gạch dưới hoặc gạch ngang (tối đa 32 ký tự).`;
    if (servers.some((s) => s.name === item.name)) return `${at}.name "${item.name}" bị trùng.`;
    const command = typeof item.command === 'string' ? item.command.trim() : '';
    if (!command || command.length > MAX_ARG_LENGTH || hasNul(command)) return `${at}.command phải là chuỗi không rỗng, tối đa ${MAX_ARG_LENGTH} ký tự.`;
    const server: McpServer = { name: item.name, command };
    if (item.args !== undefined) {
      if (!Array.isArray(item.args) || item.args.length > MAX_EXTRA_ARGS || item.args.some((a) => typeof a !== 'string' || a.length > MAX_ARG_LENGTH || hasNul(a))) {
        return `${at}.args phải là danh sách tối đa ${MAX_EXTRA_ARGS} chuỗi, mỗi chuỗi tối đa ${MAX_ARG_LENGTH} ký tự, không chứa ký tự NUL.`;
      }
      if (item.args.length) server.args = [...item.args] as string[];
    }
    if (item.env !== undefined) {
      const problem = envProblem(item.env, `${at}.env`);
      if (problem) return problem;
      if (Object.keys(item.env as Obj).length) server.env = { ...(item.env as Record<string, string>) };
    }
    if (item.roles !== undefined) {
      if (!Array.isArray(item.roles) || item.roles.some((r) => typeof r !== 'string' || !MCP_ROLES.includes(r))) return `${at}.roles chỉ gồm coder, reviewer hoặc thinker.`;
      server.roles = [...new Set(item.roles)] as McpServer['roles'];
    }
    servers.push(server);
  }
  return servers;
}

const HOOK_NAMES: readonly HookName[] = ['beforeTurn', 'afterTurn'];

function hooksProblem(value: unknown): Partial<Record<HookName, string>> | string {
  if (value === undefined || value === null) return {};
  if (!isObj(value)) return 'hooks phải là một đối tượng.';
  const hooks: Partial<Record<HookName, string>> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!HOOK_NAMES.includes(key as HookName)) return `hooks.${key} không hợp lệ (dùng ${HOOK_NAMES.join(', ')}).`;
    if (typeof item !== 'string' || item.length > MAX_TEST_COMMAND || hasNul(item)) return `hooks.${key} phải là chuỗi tối đa ${MAX_TEST_COMMAND} ký tự, không chứa ký tự NUL.`;
    if (item.trim()) hooks[key as HookName] = item.trim();
  }
  return hooks;
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
  const antigravity = cliProblem(input.antigravity, 'antigravity', checkFile);
  if (typeof antigravity === 'string') return antigravity;
  const problem = timeoutProblem(input.turnTimeoutMin) ?? testCommandProblem(input.testCommand);
  if (problem) return problem;
  if (input.theme !== undefined && input.theme !== null && (typeof input.theme !== 'string' || (input.theme !== '' && !THEME_ID.test(input.theme)))) return 'theme phải là mã dạng tokyo-night (chữ thường, số, gạch ngang).';
  const hooks = hooksProblem(input.hooks);
  if (typeof hooks === 'string') return hooks;
  const mcp = mcpProblem(input.mcp);
  if (typeof mcp === 'string') return mcp;
  const settings: CliSettings = { claude, codex, antigravity };
  if (typeof input.theme === 'string' && input.theme) settings.theme = input.theme;
  if (mcp.length) settings.mcp = mcp;
  if (Object.keys(hooks).length) settings.hooks = hooks;
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
