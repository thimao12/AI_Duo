import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agents, other, type AgentCheck, type AgentName, type Usage } from './agents/index.ts';
import { resolveBin } from './agents/bins.ts';
import { binVersion } from './agents/check.ts';
import { gitRequiredMessage, isGitRepo } from './git.ts';
import { acquireRepoLock, describeOwner, lockTarget, RepoLockedError, runsActiveElsewhere, type LockOwner, type RepoLock } from './lock.ts';
import { runDebate } from './modes/debate.ts';
import { runPair } from './modes/pair.ts';
import { runPlan } from './modes/plan.ts';
import { EFFORT } from './models.ts';
import { paths } from './paths.ts';
import { dataPath, isDataId, requireDataId } from './data-path.ts';
import { classifyWithHaiku, type Classifier } from './router/classify.ts';
import { autoRoute } from './router/index.ts';
import { classifyByRules, CONFIDENT } from './router/rules.ts';
import { active, newRunId, RunContext } from './run.ts';
import { deleteRun, listRuns, loadRun, saveRun, type RunSummary } from './store.ts';
import type { Mode, PlanDecisionAnswer, Run, RunConfig, RunEvent } from './types.ts';

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

export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_ONLY_PROMPT = 'Hãy phân tích ảnh đính kèm.';

export interface RunRequest {
  mode?: Mode | string;
  prompt?: string;
  /** Defaults to the service's default working directory. Ignored by follow-ups. */
  cwd?: string;
  images?: { name: string; dataUrl: string }[];
  models?: Partial<Record<AgentName, string | null>>;
  efforts?: Partial<Record<AgentName, string | null>>;
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
      if (!skipAuthCheck) problems.push(`${check.authError ?? `${check.agent}: login status unknown`} Dùng --skip-auth-check (API: skipAuthCheck) để vẫn chạy.`);
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

export function parseImages(value: unknown): ParsedImages | string {
  if (value === undefined) return { images: [], buffers: [] };
  if (!Array.isArray(value) || value.length > 4) return 'Choose up to 4 images';
  const images: NonNullable<RunConfig['images']> = [];
  const buffers: Buffer[] = [];
  for (const item of value) {
    if (!item || typeof item.name !== 'string' || typeof item.dataUrl !== 'string') return 'Invalid image';
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.dataUrl);
    if (!match) return 'Use PNG, JPEG, WebP or GIF images';
    if (match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) return 'Each image must be 5 MB or smaller';
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return 'Each image must be 5 MB or smaller';
    const mimeType = match[1];
    const valid = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : mimeType === 'image/jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      : mimeType === 'image/gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!valid) return 'Image contents do not match the selected format';
    images.push({ name: item.name.slice(0, 150), mimeType });
    buffers.push(bytes);
  }
  return { images, buffers };
}

const isAgent = (x: unknown): x is AgentName => x === 'claude' || x === 'codex';

/** Checks that need no routing: mode, prompt, model and effort names, working directory. */
function validateRequest(body: any, prompt: string): { mode: Mode; cwd: string } | string {
  if (body?.mode !== 'code' && body?.mode !== 'plan') return 'mode must be "code" or "plan"';
  if (!prompt) return 'prompt is required';
  for (const name of ['claude', 'codex'] as const) {
    const value = body.models?.[name];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `models.${name} must be a valid model name`;
    const model = value.trim();
    if (model && (!/^[\w.:\/-]{1,64}$/.test(model) || model.startsWith('-'))) {
      return `Invalid models.${name}: use 1-64 letters, numbers, or . : / _ - and do not start with -`;
    }
  }
  for (const name of ['claude', 'codex'] as const) {
    const value = body.efforts?.[name];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !EFFORT.test(value)) return `Invalid efforts.${name}: use a level like low, medium or high`;
  }
  const cwd = path.resolve(String(body.cwd ?? '').trim() || paths.defaultCwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return `Working directory not found: ${cwd}`;
  return { mode: body.mode, cwd };
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
    reviewer: isAgent(body.reviewer) ? body.reviewer : coder === 'claude' ? 'codex' : 'claude',
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
  };
}

function routeNote(ctx: RunContext, usage?: Usage) {
  const cfg = ctx.run.config;
  if (!cfg.route) return;
  const manual = Object.entries(cfg.models ?? {}).filter(([, model]) => model);
  const override = manual.length ? `\nModel đặt tay (ưu tiên hơn router): ${manual.map(([agent, model]) => `${agent}=${model}`).join(', ')}` : '';
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

  constructor(private readonly options: RunServiceOptions) {}

  /* ---- Reading ---- */

  async list(): Promise<RunSummary[]> {
    const saved = await listRuns();
    // In-progress runs may not have hit the disk yet.
    for (const ctx of active.values()) {
      if (!saved.some((s) => s.id === ctx.run.id)) {
        const r = ctx.run;
        saved.unshift({ id: r.id, title: r.title, mode: r.config.mode, prompt: r.config.prompt.slice(0, 2000), cwd: r.config.cwd, status: r.status, createdAt: r.createdAt, claudeLimits: r.claudeLimits });
      }
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
    const text = String(prompt ?? '').trim();
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
    return this.options.checkAgent ? this.options.checkAgent(agent, cwd) : agents[agent].check(cwd);
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
  private async routeChecked(prompt: string, mode: Mode, cwd: string, skipAuthCheck: boolean | undefined, checks: Checks, signal?: AbortSignal) {
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
    if (!report.ok) throw new ServiceError('preflight', `Kiểm tra agent trước khi chạy thất bại:\n${report.problems.map((p) => `- ${p}`).join('\n')}`, { preflight: report });
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

  private async saveImages(runId: string, prefix: string, parsed: ParsedImages) {
    if (!parsed.buffers.length) return;
    requireDataId(runId);
    if (prefix) requireDataId(prefix);
    const dir = await dataPath('images', runId);
    const files = await Promise.all(parsed.images.map((image, index) => dataPath('images', runId, `${prefix}${index}.${IMAGE_TYPES[image.mimeType]}`)));
    try {
      await mkdir(dir, { recursive: true });
      await Promise.all(parsed.buffers.map((bytes, index) => writeFile(files[index], bytes)));
    } catch (err) {
      await Promise.all(files.map((file) => rm(file, { force: true }).catch(() => {})));
      throw new ServiceError('internal', `Could not save images: ${(err as Error).message}`);
    }
  }

  /** Route (see routeChecked), then preflight the agents the route picked; nothing is created yet. */
  private async routeAndCheck(body: any, mode: Mode, prompt: string, cwd: string, checks: Checks) {
    const skipAuthCheck = body?.skipAuthCheck === true;
    const { route, usage, ...decision } = await this.routeChecked(prompt, mode, cwd, skipAuthCheck, checks);
    const cfg = manualConfig({ ...body, ...decision, mode }, prompt, cwd);
    await this.assertPreflight(agentsFor(cfg), cwd, skipAuthCheck, checks);
    return { cfg: { ...cfg, route }, routeUsage: usage };
  }

  private async requireGit(mode: Mode, cwd: string) {
    // Plan is read-only and works in any folder; Code diffs and reverts through Git.
    if (mode === 'code' && !(await isGitRepo(cwd))) throw new ServiceError('invalid', gitRequiredMessage(cwd));
  }

  /** Validate, lock the repository, route, check agents, then start the run. */
  async start(body: RunRequest, { onEvent, onCreated }: StartOptions = {}): Promise<RunHandle> {
    const images = parseImages(body?.images);
    if (typeof images === 'string') throw new ServiceError('invalid', images);
    const prompt = String(body?.prompt ?? '').trim() || (images.images.length ? IMAGE_ONLY_PROMPT : '');
    const valid = validateRequest(body, prompt);
    if (typeof valid === 'string') throw new ServiceError('invalid', valid);
    await this.requireGit(valid.mode, valid.cwd);

    const id = newRunId();
    const lock = await this.lock(valid.cwd, id);
    try {
      const checks: Checks = new Map();
      const { cfg, routeUsage } = await this.routeAndCheck(body, valid.mode, prompt, valid.cwd, checks);
      await this.saveImages(id, '', images);
      if (images.images.length) cfg.images = images.images;
      const ctx = new RunContext(cfg, undefined, id);
      onCreated?.(ctx.run);
      if (onEvent) ctx.subscribe(onEvent);
      routeNote(ctx, routeUsage);
      return this.launch(ctx, lock, checks);
    } catch (err) {
      await lock.release().catch(() => {});
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
      const images = parseImages(body?.images);
      if (typeof images === 'string') throw new ServiceError('invalid', images);
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt && !images.images.length) throw new ServiceError('invalid', 'prompt is required');
      if (body?.mode !== undefined && body.mode !== 'code' && body.mode !== 'plan') throw new ServiceError('invalid', 'Invalid mode');
      const previous = await loadRun(id);
      if (!previous) throw new ServiceError('not_found', 'not found');
      const owner = await this.activeElsewhere(id);
      if (owner) throw new ServiceError('conflict', `Phiên đang chạy ở tiến trình khác: ${describeOwner(owner)}. Hãy đợi hoàn tất.`);
      const nextPrompt = prompt || IMAGE_ONLY_PROMPT;
      const request = { ...body, mode: body?.mode === 'plan' ? 'plan' : 'code', cwd: previous.config.cwd };
      const valid = validateRequest(request, nextPrompt);
      if (typeof valid === 'string') throw new ServiceError('invalid', valid);
      await this.requireGit(valid.mode, valid.cwd);

      lock = await this.lock(valid.cwd, id);
      // Read again under the lock: another process may have just finished writing this run.
      const run = await loadRun(id);
      if (!run) throw new ServiceError('not_found', 'not found');
      const checks: Checks = new Map();
      const { cfg, routeUsage } = await this.routeAndCheck(request, valid.mode, nextPrompt, valid.cwd, checks);
      run.config = { ...run.config, ...cfg, prompt: run.config.prompt, cwd: run.config.cwd, images: run.config.images };
      const messageId = randomUUID();
      await this.saveImages(id, `${messageId}-`, images);
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

  private launch(ctx: RunContext, lock: RepoLock, checks: Checks): RunHandle {
    const cfg = ctx.run.config;
    active.set(ctx.run.id, ctx);
    const done = (async () => {
      let status: 'done' | 'error' | 'cancelled' = 'done';
      let error: string | undefined;
      try {
        if (cfg.mode === 'debate') await runDebate(ctx); // Existing saved threads remain resumable.
        else if (cfg.mode === 'plan') {
          const approved = await runPlan(ctx);
          if (approved && !ctx.cancelled) {
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
        } else {
          await runPair(ctx);
        }
        if (ctx.cancelled) status = 'cancelled';
      } catch (err) {
        status = ctx.cancelled ? 'cancelled' : 'error';
        error = status === 'error' ? (err as Error).message : undefined;
        ctx.abort.abort();
        await Promise.allSettled([...ctx.inflight]);
      }
      try {
        await ctx.finish(status, error);
      } catch (err) {
        console.error(`Failed to save finished run ${ctx.run.id}:`, err);
      } finally {
        // Agents have stopped and the run is saved: only now may another run take the repository.
        await lock.release().catch((err) => console.error(`Failed to release the repository lock for ${ctx.run.id}:`, err));
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
