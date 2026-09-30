import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentName } from './agents/types.ts';
import { appDataRoot } from './app-data.ts';
import { loadCliSettings, validateCliSettings } from './cli-settings.ts';
import { renameWithRetry } from './data-path.ts';
import { effortNameProblem, modelNameProblem } from './models.ts';
import type { CliSettings, PipelineDef, PipelineStep, RoleDef } from './types.ts';

/**
 * User settings (roles and pipelines) in one JSON file next to the run history, written atomically.
 * AI_DUO_SETTINGS_FILE points elsewhere (tests); it is read on every call, never cached.
 */

export const ID_PATTERN = /^[a-z0-9-]{1,32}$/;
export const MAX_ROLES = 24;
export const MAX_PIPELINES = 24;
export const MAX_STEPS = 12;
export const MAX_LOOPS = 10;
export const DEFAULT_MAX_LOOPS = 2;
export const MAX_TEMPLATE = 8000;
/** Largest settings body the API accepts. */
export const MAX_SETTINGS_BYTES = 256 * 1024;

export interface Settings {
  roles: RoleDef[];
  pipelines: PipelineDef[];
  cli: CliSettings;
}

export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.AI_DUO_SETTINGS_FILE || path.join(appDataRoot(env), 'settings.json');
}

const GRADE_RULE = 'Kết thúc câu trả lời bằng đúng một dòng: VERDICT: PASS hoặc VERDICT: FAIL.';

const DEFAULT_ROLES: readonly RoleDef[] = [
  {
    id: 'plan', name: 'Plan', icon: '🧭', description: 'Lập kế hoạch triển khai, chỉ đọc.',
    agent: 'claude', model: 'opus', effort: 'high', permission: 'read', gradable: false,
    template: 'Bạn là kiến trúc sư phần mềm, chỉ đọc mã, không sửa file.\n\nNhiệm vụ:\n{{task}}\n\nNgữ cảnh trước đó:\n{{prev}}\n\nĐưa ra kế hoạch cụ thể: file liên quan, các bước theo thứ tự, trường hợp biên và cách kiểm chứng.',
  },
  {
    id: 'review', name: 'Review', icon: '🔍', description: 'Đọc và đánh giá thay đổi, cho PASS/FAIL.',
    agent: 'codex', model: '', effort: '', permission: 'read', gradable: true,
    template: `Bạn là người review mã, chỉ đọc, không sửa file.\n\nNhiệm vụ gốc:\n{{task}}\n\nKết quả cần review:\n{{prev}}\n\nKiểm tra tính đúng đắn, phạm vi và rủi ro. Liệt kê vấn đề cụ thể. ${GRADE_RULE}`,
  },
  {
    id: 'code', name: 'Code', icon: '💻', description: 'Viết và sửa mã trong dự án.',
    agent: 'claude', model: 'sonnet', effort: 'medium', permission: 'edit', gradable: false,
    template: 'Bạn là lập trình viên. Thực hiện nhiệm vụ dưới đây trong thư mục làm việc, rồi tự kiểm tra kết quả.\n\nNhiệm vụ:\n{{task}}\n\nĐầu vào từ bước trước (kế hoạch hoặc phản hồi review):\n{{prev}}',
  },
  {
    id: 'test', name: 'Test', icon: '🧪', description: 'Đánh giá kết quả có đạt yêu cầu không, cho PASS/FAIL.',
    agent: 'codex', model: '', effort: '', permission: 'read', gradable: true,
    template: `Bạn là kiểm thử viên, chỉ đọc, không sửa file.\n\nNhiệm vụ gốc:\n{{task}}\n\nKết quả cần kiểm thử:\n{{prev}}\n\nĐối chiếu kết quả với yêu cầu, nêu các lỗi tìm thấy. ${GRADE_RULE}`,
  },
  {
    id: 'debug', name: 'Debug', icon: '🐞', description: 'Tìm nguyên nhân lỗi và sửa.',
    agent: 'claude', model: 'sonnet', effort: 'high', permission: 'edit', gradable: false,
    template: 'Bạn đang gỡ lỗi. Tìm nguyên nhân gốc rễ rồi sửa tối thiểu cần thiết.\n\nMô tả lỗi:\n{{task}}\n\nThông tin thêm:\n{{prev}}',
  },
  {
    id: 'ask', name: 'Ask', icon: '💬', description: 'Hỏi đáp nhanh về mã, chỉ đọc.',
    agent: 'claude', model: 'haiku', effort: '', permission: 'read', gradable: false,
    template: 'Trả lời ngắn gọn, chính xác câu hỏi sau về dự án (chỉ đọc, không sửa file).\n\n{{task}}',
  },
];

export const defaultRoles = (): RoleDef[] => structuredClone(DEFAULT_ROLES) as RoleDef[];

/* ---- Validation ---- */

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const isAgent = (value: unknown): value is AgentName => value === 'claude' || value === 'codex';

function text(value: unknown, label: string, min: number, max: number): string | { error: string } {
  if (typeof value !== 'string') return { error: `${label} must be a string` };
  const trimmed = value.trim();
  const range = min === 0 ? `at most ${max}` : `${min}-${max}`;
  if (trimmed.length < min || value.length > max) return { error: `${label} must be ${range} characters` };
  return trimmed;
}

function idProblem(value: unknown, label: string): string | undefined {
  return typeof value === 'string' && ID_PATTERN.test(value) ? undefined : `${label} must match ${ID_PATTERN.source}`;
}

const failed = (value: unknown): value is { error: string } => typeof value === 'object' && value !== null && 'error' in value;

function roleTexts(input: Obj, at: string): Pick<RoleDef, 'name' | 'icon' | 'description' | 'template'> | string {
  const name = text(input.name, `${at}.name`, 1, 40);
  const icon = text(input.icon ?? '', `${at}.icon`, 0, 8);
  const description = text(input.description ?? '', `${at}.description`, 0, 300);
  const template = text(input.template, `${at}.template`, 1, MAX_TEMPLATE);
  for (const value of [name, icon, description, template]) if (failed(value)) return value.error;
  return { name, icon, description, template } as Pick<RoleDef, 'name' | 'icon' | 'description' | 'template'>;
}

function validateRole(input: unknown, index: number): RoleDef | string {
  const at = `roles[${index}]`;
  if (!isObj(input)) return `${at} must be an object`;
  const problem =
    idProblem(input.id, `${at}.id`) ??
    (isAgent(input.agent) ? undefined : `${at}.agent must be "claude" or "codex"`) ??
    (input.permission === 'read' || input.permission === 'edit' ? undefined : `${at}.permission must be "read" or "edit"`) ??
    (typeof input.gradable === 'boolean' ? undefined : `${at}.gradable must be a boolean`) ??
    modelNameProblem(input.model ?? '', `${at}.model`) ??
    effortNameProblem(input.effort ?? '', `${at}.effort`);
  if (problem) return problem;
  const texts = roleTexts(input, at);
  if (typeof texts === 'string') return texts;
  return {
    id: input.id as string,
    agent: input.agent as AgentName,
    model: (typeof input.model === 'string' ? input.model : '').trim(),
    effort: (typeof input.effort === 'string' ? input.effort : '').trim(),
    permission: input.permission as RoleDef['permission'],
    gradable: input.gradable as boolean,
    ...texts,
  };
}

/** The cleaned roles, or the first problem found. */
export function validateRoles(input: unknown): RoleDef[] | string {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_ROLES) return `roles must be a list of 1-${MAX_ROLES} roles`;
  const roles: RoleDef[] = [];
  for (const [index, item] of input.entries()) {
    const role = validateRole(item, index);
    if (typeof role === 'string') return role;
    if (roles.some((r) => r.id === role.id)) return `Duplicate role id "${role.id}"`;
    roles.push(role);
  }
  return roles;
}

function validateStep(input: unknown, at: string, count: number, roles: readonly RoleDef[]): PipelineStep | string {
  if (!isObj(input)) return `${at} must be an object`;
  if (typeof input.roleId !== 'string' || !roles.some((r) => r.id === input.roleId)) return `${at}.roleId must be an existing role`;
  const step: PipelineStep = { roleId: input.roleId };
  if (input.onFail !== undefined && input.onFail !== null) {
    if (!Number.isInteger(input.onFail) || (input.onFail as number) < 0 || (input.onFail as number) >= count) return `${at}.onFail must be a step index between 0 and ${count - 1}`;
    step.onFail = input.onFail as number;
  }
  if (input.maxLoops !== undefined && input.maxLoops !== null) {
    if (!Number.isInteger(input.maxLoops) || (input.maxLoops as number) < 1 || (input.maxLoops as number) > MAX_LOOPS) return `${at}.maxLoops must be a whole number from 1 to ${MAX_LOOPS}`;
    step.maxLoops = input.maxLoops as number;
  }
  return step;
}

function validatePipeline(input: unknown, index: number, roles: readonly RoleDef[]): PipelineDef | string {
  const at = `pipelines[${index}]`;
  if (!isObj(input)) return `${at} must be an object`;
  const problem = idProblem(input.id, `${at}.id`);
  if (problem) return problem;
  const name = text(input.name, `${at}.name`, 1, 60);
  if (failed(name)) return name.error;
  const raw = input.steps;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_STEPS) return `${at}.steps must list 1-${MAX_STEPS} steps`;
  const steps: PipelineStep[] = [];
  for (const [i, item] of raw.entries()) {
    const step = validateStep(item, `${at}.steps[${i}]`, raw.length, roles);
    if (typeof step === 'string') return step;
    steps.push(step);
  }
  return { id: input.id as string, name, steps };
}

/** The cleaned pipelines (steps must use roles in `roles`), or the first problem found. */
export function validatePipelines(input: unknown, roles: readonly RoleDef[]): PipelineDef[] | string {
  if (!Array.isArray(input) || input.length > MAX_PIPELINES) return `pipelines must be a list of at most ${MAX_PIPELINES} pipelines`;
  const pipelines: PipelineDef[] = [];
  for (const [index, item] of input.entries()) {
    const pipeline = validatePipeline(item, index, roles);
    if (typeof pipeline === 'string') return pipeline;
    if (pipelines.some((p) => p.id === pipeline.id)) return `Duplicate pipeline id "${pipeline.id}"`;
    pipelines.push(pipeline);
  }
  return pipelines;
}

/* ---- Storage ---- */

// The CLI settings are also read synchronously (resolveBin runs on every spawn), so a copy is kept
// in memory. It belongs to one settings file: a different AI_DUO_SETTINGS_FILE loads its own.
let cliCache: { file: string; cli: CliSettings } | undefined;

function rememberCli(cli: CliSettings) {
  cliCache = { file: settingsFile(), cli };
}

/** The saved CLI settings without touching the disk after the first use; kept in sync by load and save. */
export function getCliSettingsSync(): CliSettings {
  if (cliCache?.file !== settingsFile()) {
    let stored: unknown;
    try {
      stored = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    } catch {
      stored = undefined;
    }
    rememberCli(loadCliSettings(isObj(stored) ? stored.cli : undefined));
  }
  return cliCache!.cli;
}

export async function loadSettings(): Promise<Settings> {
  let stored: unknown;
  try {
    stored = JSON.parse(await readFile(settingsFile(), 'utf8'));
  } catch {
    stored = undefined;
  }
  const saved = isObj(stored) ? stored : {};
  const roles = validateRoles(saved.roles);
  const cleanRoles = typeof roles === 'string' ? defaultRoles() : roles;
  const pipelines = validatePipelines(saved.pipelines ?? [], cleanRoles);
  const cli = loadCliSettings(saved.cli);
  rememberCli(cli);
  return { roles: cleanRoles, pipelines: typeof pipelines === 'string' ? [] : pipelines, cli };
}

let tempSequence = 0;
let writes: Promise<unknown> = Promise.resolve();

async function writeSettings(settings: Settings): Promise<void> {
  const destination = settingsFile();
  const temporary = `${destination}.${process.pid}.${++tempSequence}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2), 'utf8');
    await renameWithRetry(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Read-modify-write, one at a time, so two saves cannot interleave. */
function update(change: (current: Settings) => Settings | string): Promise<Settings | string> {
  const run = writes.catch(() => {}).then(async () => {
    const next = change(await loadSettings());
    if (typeof next !== 'string') {
      await writeSettings(next);
      rememberCli(next.cli);
    }
    return next;
  });
  writes = run;
  return run;
}

export const getRoles = async () => (await loadSettings()).roles;
export const getPipelines = async () => (await loadSettings()).pipelines;

/** Saves the roles; pipelines that use a role that no longer exists are rejected, not silently dropped. */
export function setRoles(input: unknown): Promise<RoleDef[] | string> {
  const roles = validateRoles(input);
  if (typeof roles === 'string') return Promise.resolve(roles);
  return update((current) => {
    const orphan = current.pipelines.find((p) => p.steps.some((s) => !roles.some((r) => r.id === s.roleId)));
    return orphan ? `Pipeline "${orphan.name}" still uses a role that would be removed` : { ...current, roles };
  }).then((result) => (typeof result === 'string' ? result : result.roles));
}

export function resetRoles(): Promise<RoleDef[]> {
  return update((current) => {
    const roles = defaultRoles();
    // Custom roles that pipelines use survive a reset, so no pipeline is left pointing at nothing.
    const used = current.roles.filter((r) => !roles.some((d) => d.id === r.id) && current.pipelines.some((p) => p.steps.some((s) => s.roleId === r.id)));
    return { ...current, roles: [...roles, ...used] };
  }).then((result) => (result as Settings).roles);
}

export function setPipelines(input: unknown): Promise<PipelineDef[] | string> {
  return update((current) => {
    const pipelines = validatePipelines(input, current.roles);
    return typeof pipelines === 'string' ? pipelines : { ...current, pipelines };
  }).then((result) => (typeof result === 'string' ? result : result.pipelines));
}

export const getCliSettings = async () => (await loadSettings()).cli;

/** Saves the per-CLI configuration; returns the cleaned settings or the first problem (Vietnamese). */
export function setCliSettings(input: unknown): Promise<CliSettings | string> {
  const cli = validateCliSettings(input);
  if (typeof cli === 'string') return Promise.resolve(cli);
  return update((current) => ({ ...current, cli })).then((result) => (typeof result === 'string' ? result : result.cli));
}
