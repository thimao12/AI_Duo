import { randomUUID } from 'node:crypto';
import { agents, other, type AgentCheck, type AgentName, type Usage } from './agents/index.ts';
import { resolveBin } from './agents/bins.ts';
import { binVersion } from './agents/check.ts';
import { gitRequiredMessage, isGitRepo } from './git.ts';
import { acquireRepoLock, describeOwner, lockTarget, RepoLockedError, runsActiveElsewhere, type LockOwner, type RepoLock } from './lock.ts';
import { runDebate } from './modes/debate.ts';
import { runPair } from './modes/pair.ts';
import { planPipeline, runPipeline, runRole } from './modes/pipeline.ts';
import { runPlan } from './modes/plan.ts';
import { effortNameProblem, modelNameProblem } from './models.ts';
import { getRoles, ID_PATTERN, loadSettings, type Settings } from './settings.ts';
import { paths } from './paths.ts';
import { isDataId, writeRunImages } from './data-path.ts';
import { authorizeDirectory, projectDirectories } from './project-directories.ts';
import { classifyWithHaiku, type Classifier } from './router/classify.ts';
import { autoRoute } from './router/index.ts';
import { classifyByRules, CONFIDENT } from './router/rules.ts';
import { active, newRunId, RunContext } from './run.ts';
import { deleteRun, listRuns, loadRun, saveRun, summarizeRun, type RunSummary } from './store.ts';
import type { Mode, Permission, PlanDecisionAnswer, RoleDef, Run, RunConfig, RunEvent } from './types.ts';

/**
 * Everything a front end can do with runs. The HTTP API (web and desktop) and the CLI are thin
 * layers over one RunService: validation, routing, agent preflight, repository locking, the run
 * lifecycle, cancellation and decisions all live here.
 */

export type ServiceErrorCode = 'invalid' | 'not_found' | 'conflict' | 'preflight' | 'internal';

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly details: { preflight?: PreflightReport; lock?: RepoLockedError } = {},
  ) {
    super(message);
  }
}

export { IMAGE_TYPES } from './data-path.ts';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_ONLY_PROMPT = 'Hãy phân tích ảnh đính kèm.';

export interface RunRequest {
  mode?: string;
  prompt?: string;
  /** Defaults to the service's default working directory. Ignored by follow-ups. */
  cwd?: string;
  images?: { name: string; dataUrl: string }[];
  models?: Partial<Record<AgentName, string | null>>;
  efforts?: Partial<Record<AgentName, string | null>>;
  /** An explicit agent skips the auto-router (precedence: request fields > role > router). */
  coder?: AgentName;
  reviewer?: AgentName;
  /** Run one turn shaped by this role (template, agent, model, permission). */
  roleId?: string;
  /** 'read' needs no Git repository; overrides the role's own permission. */
  permission?: Permission;
  /** With mode 'pipeline': the pipeline (from settings) to run. */
  pipelineId?: string;
  testCommand?: string;
  turnTimeoutMin?: number;
  /** Run although a CLI cannot report its login; a confirmed bad login still stops. */
  skipAuthCheck?: boolean;
}

export interface StartOptions {
  /** Subscribed before the run emits anything, so no event is missed. */
  onEvent?: (e: RunEvent) => void;
  /** Called once the run exists, before its first event. */
  onCreated?: (run: Run) => void;
}

export interface RunHandle {
  id: string;
  /** Live run object; read it for the current snapshot. */
  readonly run: Run;
  subscribe(fn: (e: RunEvent) => void): () => void;
  /** Settles (never rejects) once the run has ended, been saved and released its lock. */
  done: Promise<Run>;
  cancel(): void;
  /** Throws ServiceError: conflict when nothing is waiting, invalid when approval cannot start Code (no Git). */
  answerPlanDecision(answer: PlanDecisionAnswer): Promise<void>;
  answerPairDecision(continueRun: boolean): boolean;
}

/** Agent checks made while handling one request, so each agent is checked once. */
type Checks = Map<AgentName, AgentCheck>;

export interface PreflightReport {
  ok: boolean;
  checks: AgentCheck[];
  /** One line per problem that blocks the run. */
  problems: string[];
  /** Some CLI could not report its login; --skip-auth-check would let the run start. */
  authUnverified: boolean;
}

export function evaluatePreflight(checks: AgentCheck[], skipAuthCheck = false): PreflightReport {
  const problems: string[] = [];
  let authUnverified = false;
  for (const check of checks) {
    if (check.error) problems.push(check.error);
    else if (check.auth === 'failed') problems.push(check.authError ?? `${check.agent}: login check failed`);
    else if (check.auth === 'unknown') {
      authUnverified = true;
      if (!skipAuthCheck) {
        const reason = check.authError ?? check.agent + ': login status unknown';
        problems.push(`${reason} Dùng --skip-auth-check (API: skipAuthCheck) để vẫn chạy.`);
      }
    }
  }
  return { ok: problems.length === 0, checks, problems, authUnverified };
}

/** Agents a Code or Plan run will call, in order. */
export function agentsFor(cfg: Pick<RunConfig, 'mode' | 'coder' | 'reviewer'>): AgentName[] {
  const reviewer = cfg.reviewer ?? (cfg.mode === 'plan' ? cfg.coder : other(cfg.coder));
  return [...new Set([cfg.coder, reviewer])];
}

type ParsedImages = { images: NonNullable<RunConfig['images']>; buffers: Buffer[] };

const IMAGE_SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': (bytes) => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  'image/jpeg': (bytes) => bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')),
  'image/gif': (bytes) => /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')),
  'image/webp': (bytes) => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
};

/** One image's metadata and bytes, or the reason it is rejected. */
function parseImage(item: any): { image: NonNullable<RunConfig['images']>[number]; bytes: Buffer } | string {
  if (!item || typeof item.name !== 'string' || typeof item.dataUrl !== 'string') return 'Invalid image';
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.dataUrl);
  if (!match) return 'Use PNG, JPEG, WebP or GIF images';
  if (match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) return 'Each image must be 5 MB or smaller';
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return 'Each image must be 5 MB or smaller';
  const mimeType = match[1];
  if (!IMAGE_SIGNATURES[mimeType](bytes)) return 'Image contents do not match the selected format';
  return { image: { name: item.name.slice(0, 150), mimeType }, bytes };
}

export function parseImages(value: unknown): ParsedImages | string {
  if (value === undefined) return { images: [], buffers: [] };
  if (!Array.isArray(value) || value.length > 4) return 'Choose up to 4 images';
  const images: NonNullable<RunConfig['images']> = [];
  const buffers: Buffer[] = [];
  for (const item of value) {
    const parsed = parseImage(item);
    if (typeof parsed === 'string') return parsed;
    images.push(parsed.image);
    buffers.push(parsed.bytes);
  }
  return { images, buffers };
}

const isAgent = (x: unknown): x is AgentName => x === 'claude' || x === 'codex';

function modelProblem(body: any): string | undefined {
  return modelNameProblem(body.models?.claude, 'models.claude') ?? modelNameProblem(body.models?.codex, 'models.codex');
}

function effortProblem(body: any): string | undefined {
  return effortNameProblem(body.efforts?.claude, 'efforts.claude') ?? effortNameProblem(body.efforts?.codex, 'efforts.codex');
}

const MODES: ReadonlySet<string> = new Set(['code', 'plan', 'pipeline']);

/** Role, permission and pipeline fields of a request. */
function selectionProblem(body: any): string | undefined {
  for (const key of ['roleId', 'pipelineId'] as const) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || !ID_PATTERN.test(body[key]))) return `${key} is not a valid id`;
  }
  if (body.permission !== undefined && body.permission !== 'read' && body.permission !== 'edit') return 'permission must be "read" or "edit"';
  if (body.mode === 'plan' && body.roleId !== undefined) return 'roleId cannot be used with mode "plan"';
  if (body.mode === 'pipeline' && !body.pipelineId) return 'pipelineId is required for mode "pipeline"';
  return undefined;
}

/** Checks that need no routing: mode, prompt, model and effort names, working directory. */
function validateRequest(body: any, prompt: string): { mode: Mode; cwd: string } | string {
  if (typeof body?.mode !== 'string' || !MODES.has(body.mode)) return 'mode must be "code", "plan" or "pipeline"';
  if (!prompt) return 'prompt is required';
  const problem = modelProblem(body) ?? effortProblem(body) ?? selectionProblem(body);
  if (problem) return problem;
  try {
    const cwd = authorizeDirectory(String(body.cwd ?? '').trim() || paths.defaultCwd);
    return { mode: body.mode, cwd };
  } catch (err) {
    return (err as Error).message;
  }
}

function manualConfig(body: any, prompt: string, cwd: string): RunConfig {
  const maxRounds = 2;
  const coder = isAgent(body.coder) ? body.coder : 'codex';
  return {
    mode: body.mode,
    prompt,
    cwd,
    maxRounds,
    judge: isAgent(body.judge) ? body.judge : 'claude',
    coder,
    reviewer: isAgent(body.reviewer) ? body.reviewer : other(coder),
    testCommand: String(body.testCommand ?? '').trim() || undefined,
    turnTimeoutMin: Math.min(Math.max(Number(body.turnTimeoutMin) || 30, 1), 180),
    models: {
      claude: String(body.models?.claude ?? '').trim() || undefined,
      codex: String(body.models?.codex ?? '').trim() || undefined,
    },
    efforts: {
      claude: String(body.efforts?.claude ?? '').trim() || undefined,
      codex: String(body.efforts?.codex ?? '').trim() || undefined,
    },
    skipAuthCheck: body.skipAuthCheck === true || undefined,
    // Always present (possibly undefined) so a follow-up replaces the previous run's values.
    roleId: body.mode === 'plan' ? undefined : validId(body.roleId),
    permission: body.mode !== 'plan' && (body.permission === 'read' || body.permission === 'edit') ? body.permission : undefined,
    pipelineId: body.mode === 'pipeline' ? validId(body.pipelineId) : undefined,
  };
}

const validId = (value: unknown): string | undefined => (typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined);

/** How a request picks agents: by router (`manual` false) or explicitly, through a role, a pipeline or an agent. */
interface Selection {
  body: any;
  manual: boolean;
  /** Agents to check before the run; defaults to the ones in the config. */
  agents?: AgentName[];
  /** Nothing can be written: no Git repository or repository lock is needed. */
  readOnly: boolean;
}

/** Routing stays on for Code/Plan; the agents of a Code/Plan run are checked from the config. */
type RoutedMode = 'code' | 'plan';

function requireImages(body: RunRequest): ParsedImages {
  const images = parseImages(body?.images);
  if (typeof images === 'string') throw new ServiceError('invalid', images);
  return images;
}

/** The follow-up's trimmed prompt (empty when only images were sent); throws when the request is unusable. */
function followUpPrompt(body: RunRequest, images: ParsedImages): string {
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt && !images.images.length) throw new ServiceError('invalid', 'prompt is required');
  if (body?.mode !== undefined && !MODES.has(body.mode)) throw new ServiceError('invalid', 'Invalid mode');
  return prompt;
}

/** A follow-up stays a Code run unless it asks for Plan or a pipeline. */
function followMode(body: RunRequest): Mode {
  return body?.mode === 'plan' || body?.mode === 'pipeline' ? body.mode : 'code';
}

function selectRole(body: any, role: RoleDef): Selection {
  // Explicit request fields win over the role.
  const agent: AgentName = isAgent(body.coder) ? body.coder : role.agent;
  const permission: Permission = body.permission === 'read' || body.permission === 'edit' ? body.permission : role.permission;
  return { body: { ...body, coder: agent, reviewer: agent, permission }, manual: true, agents: [agent], readOnly: permission === 'read' };
}

function selectPipeline(body: any, settings: Settings): Selection {
  const steps = planPipeline(body.pipelineId, settings);
  if (typeof steps === 'string') throw new ServiceError('invalid', steps);
  const agents = [...new Set(steps.map((s) => s.role.agent))];
  return { body: { ...body, coder: agents[0], reviewer: agents[0], permission: undefined }, manual: true, agents, readOnly: steps.every((s) => s.role.permission === 'read') };
}

/** Precedence: explicit request fields > role > router. */
async function selectAgents(body: any, mode: Mode): Promise<Selection> {
  if (mode === 'pipeline') return selectPipeline(body, await loadSettings());
  if (body.roleId) {
    const role = (await getRoles()).find((r) => r.id === body.roleId);
    if (!role) throw new ServiceError('invalid', `Role "${body.roleId}" not found`);
    return selectRole(body, role);
  }
  if (mode === 'code' && body.permission === 'read') {
    const agent: AgentName = isAgent(body.coder) ? body.coder : 'claude';
    return { body: { ...body, coder: agent, reviewer: agent }, manual: true, agents: [agent], readOnly: true };
  }
  if (isAgent(body.coder) || isAgent(body.reviewer)) {
    const coder: AgentName = isAgent(body.coder) ? body.coder : other(body.reviewer);
    const fallback = mode === 'plan' ? coder : other(coder);
    const reviewer: AgentName = isAgent(body.reviewer) ? body.reviewer : fallback;
    return { body: { ...body, coder, reviewer }, manual: true, readOnly: false };
  }
  return { body, manual: false, readOnly: false };
}

function routeNote(ctx: RunContext, usage?: Usage) {
  const cfg = ctx.run.config;
  if (!cfg.route) return;
  const manual = Object.entries(cfg.models ?? {}).filter(([, model]) => model);
  const manualList = manual.map(([agent, model]) => agent + '=' + model).join(', ');
  const override = manual.length ? `\nModel đặt tay (ưu tiên hơn router): ${manualList}` : '';
  ctx.note('Định tuyến tự động', cfg.route.reason + override, 'info', 0, usage);
}

export interface RunServiceOptions {
  /** Recorded in lock files so a conflict can say who holds the repository (cli, server, desktop). */
  app: string;
  /** Checks one agent before a run; defaults to the adapter's own check. */
  checkAgent?: (agent: AgentName, cwd: string) => Promise<AgentCheck>;
  /** Model classifier for prompts the rules cannot place; defaults to Haiku. */
  classify?: Classifier;
}

export class RunService {
  private readonly handles = new Map<string, RunHandle>();
  private readonly pendingFollowUps = new Set<string>();

  constructor(private readonly options: RunServiceOptions) { projectDirectories(paths.defaultCwd); }

  /* ---- Reading ---- */

  async list(): Promise<RunSummary[]> {
    const saved = await listRuns();
    // In-progress runs may not have hit the disk yet.
    for (const ctx of active.values()) {
      if (!saved.some((s) => s.id === ctx.run.id)) saved.unshift(summarizeRun(ctx.run));
    }
    return saved.map((s) => (active.has(s.id) ? { ...s, title: active.get(s.id)!.run.title, status: 'running' } : s));
  }

  async get(id: string): Promise<Run | undefined> {
    return active.get(id)?.run ?? (await loadRun(id));
  }

  /** Handle for a run active in this process. */
  handle(id: string): RunHandle | undefined {
    return this.handles.get(id);
  }

  async rename(id: string, title: unknown): Promise<string> {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) throw new ServiceError('invalid', 'Title must be 1–120 characters');
    // Its owner keeps checkpointing the run; saving our older copy would overwrite newer progress.
    const owner = !active.has(id) && (await this.activeElsewhere(id));
    if (owner) throw new ServiceError('conflict', `Phiên đang chạy ở tiến trình khác (${owner.app}, PID ${owner.pid}); đổi tên sau khi phiên kết thúc.`);
    const run = await this.get(id);
    if (!run) throw new ServiceError('not_found', 'not found');
    run.title = title.trim();
    await saveRun(run);
    return run.title;
  }

  /** Owner of the lock when another AI Duo process (CLI, desktop, another server) runs this run. */
  async activeElsewhere(id: string): Promise<LockOwner | undefined> {
    return (await runsActiveElsewhere()).get(id);
  }

  async delete(id: string) {
    // Active here or in another process, which would write the run back.
    if (active.has(id) || (await this.activeElsewhere(id))) throw new ServiceError('conflict', 'Dừng phiên đang chạy trước khi xóa.');
    if (!(await deleteRun(id))) throw new ServiceError('not_found', 'not found');
  }

  /** Rules-only preview for the form: free and instant; says whether Haiku would be asked. */
  async previewRoute(prompt: unknown, mode: unknown) {
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (!text) throw new ServiceError('invalid', 'prompt is required');
    const selected: Mode = mode === 'plan' ? 'plan' : 'code';
    const { route, coder, reviewer, maxRounds } = await autoRoute(text, { classify: false, mode: selected });
    return { mode: selected, coder, reviewer, maxRounds, route, askHaiku: classifyByRules(text).confidence < CONFIDENT };
  }

  /** Version and path of both CLIs, without the login check (cheap enough for page load). */
  async agentVersions() {
    const info = async (name: AgentName) => {
      try {
        const bin = resolveBin(name);
        return { version: (await binVersion(bin)).version, path: bin.resolvedFrom, error: null };
      } catch (err) {
        return { version: null, path: null, error: (err as Error).message };
      }
    };
    const [claude, codex] = await Promise.all([info('claude'), info('codex')]);
    return { claude, codex };
  }

  /* ---- Preflight ---- */

  private checkAgent(agent: AgentName, cwd: string) {
    let directory: string;
    try { directory = authorizeDirectory(cwd); }
    catch (err) { throw new ServiceError('invalid', (err as Error).message); }
    return this.options.checkAgent ? this.options.checkAgent(agent, directory) : agents[agent].check(directory);
  }

  /** Binary, version and login of each agent; never calls a model. */
  async preflight(names: AgentName[], cwd: string, skipAuthCheck = false): Promise<PreflightReport> {
    const checks = await Promise.all([...new Set(names)].map((name) => this.checkAgent(name, cwd)));
    return evaluatePreflight(checks, skipAuthCheck);
  }

  /** Check the agents not in `checks` yet (one check per agent per request) and report on `names`. */
  private async checked(names: AgentName[], cwd: string, skipAuthCheck: boolean | undefined, checks: Checks): Promise<PreflightReport> {
    const unique = [...new Set(names)];
    await Promise.all(unique.filter((name) => !checks.has(name)).map(async (name) => checks.set(name, await this.checkAgent(name, cwd))));
    return evaluatePreflight(unique.map((name) => checks.get(name)!), skipAuthCheck);
  }

  /**
   * Route without calling any model before the agents it needs have passed preflight. The only
   * model the router may call is Haiku (through Claude), for prompts the keyword rules cannot place;
   * it is asked only when both agents – the classifier and anything the route could pick – are
   * usable. Otherwise the rules decide, and the routed agents are checked afterwards as usual.
   */
  private async routeChecked(prompt: string, mode: RoutedMode, cwd: string, skipAuthCheck: boolean | undefined, checks: Checks, signal?: AbortSignal) {
    let classify: Classifier | false = false;
    if (classifyByRules(prompt).confidence < CONFIDENT) {
      const all = await this.checked(['claude', 'codex'], cwd, skipAuthCheck, checks);
      // The classifier itself never runs on an unverified login (see assertPlanOnly), so require 'ok'.
      if (all.ok && checks.get('claude')?.auth === 'ok') classify = this.options.classify ?? classifyWithHaiku;
    }
    return autoRoute(prompt, { mode, classify, signal });
  }

  private async assertPreflight(names: AgentName[], cwd: string, skipAuthCheck: boolean | undefined, checks: Checks) {
    const report = await this.checked(names, cwd, skipAuthCheck, checks);
    if (!report.ok) throw new ServiceError('preflight', `Kiểm tra agent trước khi chạy thất bại:\n${report.problems.map((p) => '- ' + p).join('\n')}`, { preflight: report });
  }

  /* ---- Starting runs ---- */

  private async lock(cwd: string, runId: string): Promise<RepoLock> {
    try {
      return await acquireRepoLock(await lockTarget(cwd), runId, this.options.app);
    } catch (err) {
      if (err instanceof RepoLockedError) throw new ServiceError('conflict', err.message, { lock: err });
      throw new ServiceError('internal', `Cannot lock working directory: ${(err as Error).message}`);
    }
  }

  private async saveImages(runId: string, messageId: string | undefined, parsed: ParsedImages) {
    if (!parsed.buffers.length) return;
    try {
      await writeRunImages(runId, parsed.images.map((image, index) => ({ mimeType: image.mimeType, bytes: parsed.buffers[index] })), messageId);
    } catch (err) {
      throw new ServiceError('internal', `Could not save images: ${(err as Error).message}`);
    }
  }

  /** Route (see routeChecked), then preflight the agents the route picked; nothing is created yet. */
  private async routeAndCheck(body: any, mode: RoutedMode, prompt: string, cwd: string, checks: Checks) {
    const skipAuthCheck = body?.skipAuthCheck === true;
    const { route, usage, ...decision } = await this.routeChecked(prompt, mode, cwd, skipAuthCheck, checks);
    const cfg = manualConfig({ ...body, ...decision, mode }, prompt, cwd);
    await this.assertPreflight(agentsFor(cfg), cwd, skipAuthCheck, checks);
    return { cfg: { ...cfg, route }, routeUsage: usage };
  }

  /** The config for a request: routed, or built from an explicit agent, role or pipeline (no router, no model call). */
  private async configure(sel: Selection, mode: Mode, prompt: string, cwd: string, checks: Checks) {
    if (!sel.manual && mode !== 'pipeline') return this.routeAndCheck(sel.body, mode, prompt, cwd, checks);
    const cfg = manualConfig({ ...sel.body, mode }, prompt, cwd);
    await this.assertPreflight(sel.agents ?? agentsFor(cfg), cwd, sel.body?.skipAuthCheck === true, checks);
    return { cfg, routeUsage: undefined };
  }

  /** Plan is read-only and needs an allowed folder; Code (and pipelines that edit) also need an allowed Git root. */
  private async requireGit(sel: Selection, mode: Mode, cwd: string) {
    if (sel.readOnly || mode === 'plan') return;
    if (!(await isGitRepo(cwd))) throw new ServiceError('invalid', gitRequiredMessage(cwd));
  }

  /** Read-only runs change nothing, so they do not take the repository lock. */
  private lockFor(sel: Selection, cwd: string, runId: string): Promise<RepoLock | undefined> {
    return sel.readOnly ? Promise.resolve(undefined) : this.lock(cwd, runId);
  }

  /** Validate, lock the repository, route, check agents, then start the run. */
  async start(body: RunRequest, { onEvent, onCreated }: StartOptions = {}): Promise<RunHandle> {
    const images = requireImages(body);
    const prompt = String(body?.prompt ?? '').trim() || (images.images.length ? IMAGE_ONLY_PROMPT : '');
    const valid = validateRequest(body, prompt);
    if (typeof valid === 'string') throw new ServiceError('invalid', valid);
    const sel = await selectAgents(body, valid.mode);
    await this.requireGit(sel, valid.mode, valid.cwd);

    const id = newRunId();
    const lock = await this.lockFor(sel, valid.cwd, id);
    try {
      const checks: Checks = new Map();
      const { cfg, routeUsage } = await this.configure(sel, valid.mode, prompt, valid.cwd, checks);
      await this.saveImages(id, undefined, images);
      if (images.images.length) cfg.images = images.images;
      const ctx = new RunContext(cfg, undefined, id);
      onCreated?.(ctx.run);
      if (onEvent) ctx.subscribe(onEvent);
      routeNote(ctx, routeUsage);
      return this.launch(ctx, lock, checks);
    } catch (err) {
      await lock?.release().catch(() => {});
      throw err;
    }
  }

  /** Continue a finished run with a new request, in the same thread. */
  async continue(id: string, body: RunRequest, { onEvent, onCreated }: StartOptions = {}): Promise<RunHandle> {
    if (!isDataId(id)) throw new ServiceError('not_found', 'not found');
    if (active.has(id) || this.pendingFollowUps.has(id)) throw new ServiceError('conflict', 'Phiên đang chạy, hãy đợi hoàn tất.');
    this.pendingFollowUps.add(id);
    let lock: RepoLock | undefined;
    try {
      const images = requireImages(body);
      const prompt = followUpPrompt(body, images);
      const previous = await loadRun(id);
      if (!previous) throw new ServiceError('not_found', 'not found');
      const owner = await this.activeElsewhere(id);
      if (owner) throw new ServiceError('conflict', `Phiên đang chạy ở tiến trình khác: ${describeOwner(owner)}. Hãy đợi hoàn tất.`);
      const nextPrompt = prompt || IMAGE_ONLY_PROMPT;
      const request = { ...body, mode: followMode(body), cwd: previous.config.cwd };
      const valid = validateRequest(request, nextPrompt);
      if (typeof valid === 'string') throw new ServiceError('invalid', valid);
      const sel = await selectAgents(request, valid.mode);
      await this.requireGit(sel, valid.mode, valid.cwd);

      lock = await this.lockFor(sel, valid.cwd, id);
      // Read again under the lock: another process may have just finished writing this run.
      const run = await loadRun(id);
      if (!run) throw new ServiceError('not_found', 'not found');
      const checks: Checks = new Map();
      const { cfg, routeUsage } = await this.configure(sel, valid.mode, nextPrompt, valid.cwd, checks);
      run.config = { ...run.config, ...cfg, prompt: run.config.prompt, cwd: run.config.cwd, images: run.config.images };
      const messageId = randomUUID();
      await this.saveImages(id, messageId, images);
      const ctx = new RunContext(run.config, run);
      onCreated?.(ctx.run);
      if (onEvent) ctx.subscribe(onEvent);
      ctx.followUp(nextPrompt, images.images, messageId);
      routeNote(ctx, routeUsage);
      const handle = this.launch(ctx, lock, checks);
      lock = undefined; // the run owns it now
      return handle;
    } catch (err) {
      await lock?.release().catch(() => {});
      if (err instanceof ServiceError) throw err;
      throw new ServiceError('internal', `Could not continue run: ${(err as Error).message}`);
    } finally {
      this.pendingFollowUps.delete(id);
    }
  }

  /** Plan first; once the user approves, route and run the plan as Code. */
  private async runPlanThenCode(ctx: RunContext, checks: Checks) {
    const cfg = ctx.run.config;
    const approved = await runPlan(ctx);
    if (!approved || ctx.cancelled) return;
    const approvedPlan = ctx.run.final ?? '';
    const task = ctx.run.config.prompt;
    const implementationPrompt = `Implement the approved plan for this task. Follow the plan and verify the changes.\n\nOriginal task:\n${task}\n\nUser-approved plan:\n${approvedPlan}`;
    ctx.followUp(implementationPrompt);
    // Same order as a new run: no model call before the agents it needs have passed preflight.
    const { route, usage, mode, coder, reviewer, judge } = await this.routeChecked(implementationPrompt, 'code', cfg.cwd, cfg.skipAuthCheck, checks, ctx.abort.signal);
    Object.assign(ctx.run.config, { mode, coder, reviewer, judge, maxRounds: 2, route });
    ctx.note('Đã duyệt kế hoạch · bắt đầu Code', route.reason, 'info', 0, usage);
    // Code may route to an agent the plan did not use.
    const report = await this.checked(agentsFor(ctx.run.config), cfg.cwd, cfg.skipAuthCheck, checks);
    if (!report.ok) throw new Error(`Kiểm tra agent trước khi Code thất bại:\n${report.problems.join('\n')}`);
    await runPair(ctx);
  }

  /** Runs the mode the config asks for; a role, permission or pipeline picks a runner over Code. */
  private async execute(ctx: RunContext, checks: Checks) {
    const cfg = ctx.run.config;
    if (cfg.mode === 'debate') await runDebate(ctx); // Existing saved threads remain resumable.
    else if (cfg.mode === 'pipeline') await runPipeline(ctx);
    else if (cfg.mode === 'plan') await this.runPlanThenCode(ctx, checks);
    else if (cfg.roleId || cfg.permission === 'read') await runRole(ctx);
    else await runPair(ctx);
  }

  private launch(ctx: RunContext, lock: RepoLock | undefined, checks: Checks): RunHandle {
    const cfg = ctx.run.config;
    active.set(ctx.run.id, ctx);
    const done = (async () => {
      let status: 'done' | 'error' | 'cancelled' = 'done';
      let error: string | undefined;
      try {
        await this.execute(ctx, checks);
        if (ctx.cancelled) status = 'cancelled';
      } catch (err) {
        status = ctx.cancelled ? 'cancelled' : 'error';
        error = status === 'error' ? (err as Error).message : undefined;
        ctx.abort.abort();
        await Promise.allSettled(ctx.inflight);
      }
      try {
        await ctx.finish(status, error);
      } catch (err) {
        console.error(`Failed to save finished run ${ctx.run.id}:`, err);
      } finally {
        // Agents have stopped and the run is saved: only now may another run take the repository.
        await lock?.release().catch((err) => console.error(`Failed to release the repository lock for ${ctx.run.id}:`, err));
        active.delete(ctx.run.id);
        this.handles.delete(ctx.run.id);
      }
      return ctx.run;
    })();

    const handle: RunHandle = {
      id: ctx.run.id,
      get run() {
        return ctx.run;
      },
      subscribe: (fn) => ctx.subscribe(fn),
      done,
      cancel: () => {
        ctx.userCancelled = true;
        ctx.abort.abort();
      },
      answerPlanDecision: async (answer) => {
        if (!ctx.run.planDecision) throw new ServiceError('conflict', 'no Plan decision is waiting');
        if (answer.action === 'approve') {
          try { authorizeDirectory(cfg.cwd); }
          catch (err) { throw new ServiceError('invalid', (err as Error).message); }
        }
        // Checked now, not only when asked: the user may have run `git init` meanwhile.
        if (answer.action === 'approve' && !(await isGitRepo(cfg.cwd))) {
          throw new ServiceError('invalid', `${gitRequiredMessage(cfg.cwd)} The plan is still waiting: refine or stop it, or approve again after \`git init\`.`);
        }
        if (!ctx.answerPlanDecision(answer)) throw new ServiceError('conflict', 'Plan decision is no longer waiting');
      },
      answerPairDecision: (continueRun) => ctx.answerPairDecision(continueRun),
    };
    this.handles.set(ctx.run.id, handle);
    return handle;
  }

  /* ---- Controlling active runs ---- */

  cancel(id: string): boolean {
    const handle = this.handles.get(id);
    if (!handle) return false;
    handle.cancel();
    return true;
  }

  answerPairDecision(id: string, body: any) {
    const handle = this.handles.get(id);
    if (!handle?.run.pairDecision) throw new ServiceError('conflict', 'no Pair decision is waiting');
    if (typeof body?.continue !== 'boolean') throw new ServiceError('invalid', 'continue must be a boolean');
    if (!handle.answerPairDecision(body.continue)) throw new ServiceError('conflict', 'Pair decision is no longer waiting');
  }

  async answerPlanDecision(id: string, body: any) {
    const handle = this.handles.get(id);
    if (!handle?.run.planDecision) throw new ServiceError('conflict', 'no Plan decision is waiting');
    if (!['approve', 'stop', 'refine'].includes(body?.action)) throw new ServiceError('invalid', 'action must be approve, stop or refine');
    if (body.action === 'refine' && (typeof body.feedback !== 'string' || !body.feedback.trim())) throw new ServiceError('invalid', 'feedback is required to refine the plan');
    const answer: PlanDecisionAnswer = body.action === 'refine' ? { action: 'refine', feedback: body.feedback.trim().slice(0, 8000) } : { action: body.action };
    await handle.answerPlanDecision(answer);
  }

  /** Stop every active run and wait until each is saved and has released its lock. */
  abortAll(): Promise<void> {
    const handles = [...this.handles.values()];
    for (const handle of handles) handle.cancel(); // Shutting down is a deliberate stop, not a failure.
    return Promise.all(handles.map((handle) => handle.done)).then(() => {});
  }
}
