import type { AgentEvent, AgentName } from './agents/types.ts';

export type Mode = 'debate' | 'pair';
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
  models?: Partial<Record<AgentName, string>>;
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
}

export type RunEvent =
  | { type: 'snapshot'; run: Run }
  | { type: 'message.start'; message: Message }
  | { type: 'message.event'; id: string; event: AgentEvent }
  | { type: 'message.end'; id: string; status: Message['status']; verdict?: Verdict; endedAt: number }
  | { type: 'run.update'; patch: Partial<Pick<Run, 'status' | 'final' | 'diff' | 'error' | 'endedAt'>> };

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
