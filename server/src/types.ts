import type { AgentEvent, AgentName, Role, Usage } from './agents/types.ts';

export type Mode = 'debate' | 'pair';

/** Which model a turn uses: its role, plus 'judge' for the debate synthesis. */
export type ModelRole = Role | 'judge';
export type Tier = 'light' | 'standard' | 'heavy';
export type TaskType = 'edit' | 'bugfix' | 'refactor' | 'design' | 'explain';

export interface ModelChoice {
  model?: string;
  effort?: string;
  tier: Tier;
}

/** What the auto-router decided for a run (kept on the config so it can be shown later). */
export interface RoutePlan {
  taskType: TaskType;
  complexity: Tier;
  /** 'rules' = keyword heuristics only; 'haiku' = a small Claude call settled an unclear prompt. */
  source: 'rules' | 'haiku';
  reason: string;
  models: Partial<Record<AgentName, Partial<Record<ModelRole, ModelChoice>>>>;
}
export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';
export type Speaker = AgentName | 'system';

export interface RunConfig {
  mode: Mode;
  prompt: string;
  cwd: string;
  maxRounds: number;
  /** debate: who writes the final synthesis */
  judge: AgentName;
  /** pair: who writes code (the other one reviews) */
  coder: AgentName;
  testCommand?: string;
  /** Max minutes a single agent turn may take before it is killed. */
  turnTimeoutMin: number;
  /** Manual per-agent model; overrides the router when set. */
  models?: Partial<Record<AgentName, string>>;
  /** Set when mode/agents/models were picked by the auto-router. */
  route?: RoutePlan;
}

export type Verdict = 'AGREE' | 'REVISE' | 'APPROVE' | 'CHANGES_REQUESTED';

export interface Part {
  kind: 'text' | 'tool' | 'tool_result' | 'raw' | 'error';
  content: string;
}

export interface Message {
  id: string;
  agent: Speaker;
  phase: string;
  round: number;
  title: string;
  parts: Part[];
  status: 'running' | 'done' | 'error';
  verdict?: Verdict;
  /** Model the turn ran on, when known. */
  model?: string;
  usage?: Usage;
  startedAt: number;
  endedAt?: number;
}

export interface Run {
  id: string;
  config: RunConfig;
  status: RunStatus;
  createdAt: number;
  endedAt?: number;
  messages: Message[];
  final?: string;
  diff?: string;
  error?: string;
  /** Sum over all turns that reported usage. */
  usage?: Usage;
}

export type RunEvent =
  | { type: 'snapshot'; run: Run }
  | { type: 'message.start'; message: Message }
  | { type: 'message.event'; id: string; event: AgentEvent }
  | { type: 'message.end'; id: string; status: Message['status']; verdict?: Verdict; usage?: Usage; endedAt: number }
  | { type: 'run.update'; patch: Partial<Pick<Run, 'status' | 'final' | 'diff' | 'error' | 'endedAt' | 'usage'>> };

export function addUsage(a: Usage | undefined, b: Usage): Usage {
  const costUsd = a?.costUsd !== undefined || b.costUsd !== undefined ? (a?.costUsd ?? 0) + (b.costUsd ?? 0) : undefined;
  return {
    inputTokens: (a?.inputTokens ?? 0) + b.inputTokens,
    outputTokens: (a?.outputTokens ?? 0) + b.outputTokens,
    cachedInputTokens: (a?.cachedInputTokens ?? 0) + b.cachedInputTokens,
    ...(costUsd !== undefined && { costUsd }),
  };
}

/** Same reducer runs on the server and in the browser. */
export function applyAgentEvent(parts: Part[], e: AgentEvent) {
  const last = parts[parts.length - 1];
  if (e.kind === 'text_delta') {
    if (last?.kind === 'text') last.content += e.content;
    else parts.push({ kind: 'text', content: e.content });
  } else if (e.kind === 'text' && last?.kind === 'text') {
    last.content += (last.content ? '\n\n' : '') + e.content;
  } else {
    parts.push({ kind: e.kind === 'text' ? 'text' : e.kind, content: e.content });
  }
}
