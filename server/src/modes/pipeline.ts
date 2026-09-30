import type { AgentName } from '../agents/types.ts';
import { diffSince, isGitRepo, snapshotTree } from '../git.ts';
import { renderTemplate } from '../prompts/index.ts';
import type { RunContext, TurnResult } from '../run.ts';
import { DEFAULT_MAX_LOOPS, getCliSettingsSync, loadSettings } from '../settings.ts';
import type { Permission, PipelineStep, RoleDef, RunConfig, Verdict } from '../types.ts';
import { lastVerdict } from '../../../shared/text.ts';

/** Upper bound on steps executed in one pipeline run, whatever the loop settings say. */
export const MAX_EXECUTIONS = 60;

/** PASS/FAIL from a gradable role, shown like the other verdicts. A missing grade counts as a fail. */
export function parseGrade(text: string): Verdict | undefined {
  const grade = lastVerdict(text, ['PASS', 'FAIL'], true);
  if (grade === 'PASS') return 'APPROVE';
  if (grade === 'FAIL') return 'CHANGES_REQUESTED';
  return undefined;
}

/** The role's model and effort for `agent`; manual choices in the request win, and a role's own only fit its agent. */
export function roleModel(cfg: Pick<RunConfig, 'models' | 'efforts'>, role: RoleDef, agent: AgentName): { model?: string; effort?: string } {
  const own = role.agent === agent ? role : undefined;
  const manualModel = cfg.models?.[agent];
  const saved = getCliSettingsSync()[agent];
  const model = manualModel || own?.model || saved.defaultModel || undefined;
  // A manual model drops the role's effort: it was chosen for the role's own model.
  const effort = cfg.efforts?.[agent] || (manualModel ? undefined : own?.effort || saved.defaultEffort) || undefined;
  return { model, effort };
}

interface RoleTurn {
  role: RoleDef;
  agent: AgentName;
  permission: Permission;
  vars: Record<string, string>;
  round: number;
  title: string;
}

function roleTurn(ctx: RunContext, t: RoleTurn): Promise<TurnResult> {
  const { model, effort } = roleModel(ctx.run.config, t.role, t.agent);
  return ctx.turn({
    agent: t.agent,
    role: t.permission === 'edit' ? 'coder' : 'thinker',
    permission: t.permission,
    phase: 'role',
    round: t.round,
    title: t.title,
    prompt: renderTemplate(t.role.template, t.vars),
    model,
    effort,
    parseVerdict: t.role.gradable ? (text) => parseGrade(text) : undefined,
  });
}

/** Runs `work`, then records what it changed in the repository as the run's diff (only when edits are possible). */
async function withDiff(ctx: RunContext, edits: boolean, work: () => Promise<void>): Promise<void> {
  const { cwd } = ctx.run.config;
  const base = edits && (await isGitRepo(cwd)) ? await snapshotTree(cwd) : undefined;
  await work();
  if (base) ctx.update({ diff: await diffSince(cwd, base) });
}

const label = (role: RoleDef) => `${role.icon} ${role.name}`.trim();

/** A run with no saved role (only an explicit permission): the prompt goes through unchanged. */
function adHocRole(agent: AgentName, permission: Permission): RoleDef {
  return { id: 'ask', name: 'Agent', icon: '', description: '', agent, model: '', effort: '', permission, template: '{{task}}', gradable: false };
}

/** A single-role run: one turn with the role's template, model and permission. */
export async function runRole(ctx: RunContext): Promise<void> {
  const cfg = ctx.run.config;
  const saved = cfg.roleId ? (await loadSettings()).roles.find((r) => r.id === cfg.roleId) : undefined;
  if (cfg.roleId && !saved) throw new Error(`Vai trò "${cfg.roleId}" không còn tồn tại`);
  const permission = cfg.permission ?? saved?.permission ?? 'read';
  const role = saved ?? adHocRole(cfg.coder, permission);
  await withDiff(ctx, permission === 'edit', async () => {
    const result = await roleTurn(ctx, { role, agent: cfg.coder, permission, vars: { task: ctx.prompt, prev: '' }, round: 1, title: label(role) });
    ctx.update({ final: result.text });
  });
}

interface Progress {
  task: string;
  /** Output of the step that ran last: the next step's {{prev}}. */
  prev: string;
  /** Latest output per role id, usable as {{role-id}}. */
  outputs: Record<string, string>;
  failures: Map<number, number>;
  executed: number;
}

interface PlannedStep {
  step: PipelineStep;
  role: RoleDef;
}

/** Index of the step to run after `index`, or undefined when the pipeline stops here. */
function nextStep(ctx: RunContext, steps: readonly PlannedStep[], index: number, result: TurnResult, progress: Progress): number | undefined {
  const { step, role } = steps[index];
  if (!role.gradable || result.verdict === 'APPROVE') return index + 1;
  if (step.onFail === undefined) {
    ctx.note('Pipeline dừng', `${label(role)} chấm không đạt và bước này không có nhánh quay lại.`);
    return undefined;
  }
  const failures = (progress.failures.get(index) ?? 0) + 1;
  progress.failures.set(index, failures);
  const limit = step.maxLoops ?? DEFAULT_MAX_LOOPS;
  if (failures > limit) throw new Error(`${label(role)} không đạt sau ${limit} vòng lặp; pipeline dừng.`);
  ctx.note('Quay lại bước trước', `${label(role)} không đạt (lần ${failures}/${limit}), quay lại bước ${step.onFail + 1}: ${label(steps[step.onFail].role)}.`);
  return step.onFail;
}

async function runFrom(ctx: RunContext, steps: readonly PlannedStep[], index: number, progress: Progress): Promise<void> {
  if (index >= steps.length || ctx.cancelled) return;
  if (progress.executed >= MAX_EXECUTIONS) throw new Error(`Pipeline vượt quá ${MAX_EXECUTIONS} bước; dừng.`);
  const { role } = steps[index];
  progress.executed++;
  const result = await roleTurn(ctx, {
    role,
    agent: role.agent,
    permission: role.permission,
    vars: { ...progress.outputs, task: progress.task, prev: progress.prev },
    round: progress.executed,
    title: `${index + 1}/${steps.length} · ${label(role)}`,
  });
  progress.prev = result.text;
  progress.outputs[role.id] = result.text;
  ctx.update({ final: result.text });
  const next = nextStep(ctx, steps, index, result, progress);
  if (next !== undefined) await runFrom(ctx, steps, next, progress);
}

/** Every pipeline step with its role, or the reason the pipeline cannot run. */
export function planPipeline(pipelineId: string | undefined, settings: { roles: readonly RoleDef[]; pipelines: readonly { id: string; steps: PipelineStep[] }[] }): PlannedStep[] | string {
  const pipeline = settings.pipelines.find((p) => p.id === pipelineId);
  if (!pipeline) return `Pipeline "${pipelineId}" không tồn tại`;
  const steps: PlannedStep[] = [];
  for (const step of pipeline.steps) {
    const role = settings.roles.find((r) => r.id === step.roleId);
    if (!role) return `Vai trò "${step.roleId}" của pipeline không còn tồn tại`;
    steps.push({ step, role });
  }
  return steps;
}

/** Steps run in order; a gradable step that fails jumps back to its `onFail` step, up to `maxLoops` times. */
export async function runPipeline(ctx: RunContext): Promise<void> {
  const steps = planPipeline(ctx.run.config.pipelineId, await loadSettings());
  if (typeof steps === 'string') throw new Error(steps);
  const progress: Progress = { task: ctx.prompt, prev: '', outputs: {}, failures: new Map(), executed: 0 };
  await withDiff(ctx, steps.some((s) => s.role.permission === 'edit'), () => runFrom(ctx, steps, 0, progress));
}
