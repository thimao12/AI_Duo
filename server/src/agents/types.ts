export type AgentName = 'claude' | 'codex';

/**
 * thinker  – read-only: analyse / propose / critique / synthesise
 * coder    – may edit files and run commands
 * reviewer – may read and run commands (tests), told not to edit
 */
export type Role = 'thinker' | 'coder' | 'reviewer';

export type AgentEventKind =
  | 'text_delta' // streamed chunk of assistant text
  | 'text' // a complete assistant text block
  | 'tool' // agent invoked a tool / command
  | 'tool_result' // output of that tool / command
  | 'raw' // unrecognised line, shown as-is
  | 'error';

export interface AgentEvent {
  kind: AgentEventKind;
  content: string;
  /** Current account limit window, when the CLI reports one. */
  rateLimit?: { type?: string; utilization?: number; resetsAt?: number };
}

export interface RunOptions {
  prompt: string;
  images?: string[];
  cwd: string;
  role: Role;
  /** Continue an earlier conversation of the same agent. */
  sessionId?: string;
  model?: string;
  /** Reasoning effort (low | medium | high | …); omitted = CLI default. */
  effort?: string;
  signal: AbortSignal;
  timeoutMs?: number;
  onEvent: (e: AgentEvent) => void;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache (already included in inputTokens). */
  cachedInputTokens: number;
  costUsd?: number;
}

export interface RunResult {
  finalText: string;
  sessionId?: string;
  usage?: Usage;
}

export interface AgentAdapter {
  name: AgentName;
  run(opts: RunOptions): Promise<RunResult>;
}
