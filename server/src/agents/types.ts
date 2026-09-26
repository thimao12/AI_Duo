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
}

export interface RunOptions {
  prompt: string;
  cwd: string;
  role: Role;
  /** Continue an earlier conversation of the same agent. */
  sessionId?: string;
  model?: string;
  signal: AbortSignal;
  timeoutMs?: number;
  onEvent: (e: AgentEvent) => void;
}

export interface RunResult {
  finalText: string;
  sessionId?: string;
}

export interface AgentAdapter {
  name: AgentName;
  run(opts: RunOptions): Promise<RunResult>;
}
