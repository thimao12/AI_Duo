import type { AgentEvent, AgentName, Role, Usage } from './agents/types.ts';

export type Mode = 'debate' | 'pair' | 'plan';

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
export type Speaker = AgentName | 'system' | 'user';

export interface RunConfig {
  mode: Mode;
  prompt: string;
  images?: { name: string; mimeType: string }[];
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
  /** Manual reasoning effort per agent (low, medium, high, …); overrides the router's. */
  efforts?: Partial<Record<AgentName, string>>;
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
  images?: { name: string; mimeType: string }[];
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
  /** User-assigned name; the prompt remains the original task. */
  title?: string;
  config: RunConfig;
  status: RunStatus;
  createdAt: number;
  endedAt?: number;
  messages: Message[];
  /** CLI conversations used by agent turns, retained across follow-ups. */
  sessions?: Record<string, string>;
  final?: string;
  diff?: string;
  error?: string;
  /** Sum over all turns that reported usage. */
  usage?: Usage;
  /** Most recently observed Claude account limit windows. */
  claudeLimits?: Record<string, { utilization: number; resetsAt?: number }>;
}

export type RunEvent =
  | { type: 'snapshot'; run: Run }
  | { type: 'message.start'; message: Message }
  | { type: 'message.event'; id: string; event: AgentEvent }
  | { type: 'message.end'; id: string; status: Message['status']; verdict?: Verdict; usage?: Usage; endedAt: number }
  | { type: 'run.update'; patch: Partial<Pick<Run, 'status' | 'final' | 'diff' | 'error' | 'endedAt' | 'usage' | 'claudeLimits'>> };

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

/* ---- Model catalog (shared with the web UI) ---- */

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  /** Reasoning levels this model accepts, weakest first. */
  efforts: string[];
  defaultEffort?: string;
}

export interface AgentModels {
  models: ModelInfo[];
  /** What the CLI uses when AI Duo passes no model/effort. */
  default: { model?: string; effort?: string };
}

export type ModelCatalog = Record<'claude' | 'codex', AgentModels>;
