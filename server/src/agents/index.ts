import { antigravity } from './antigravity.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import type { AgentAdapter, AgentName } from './types.ts';

export const agents: Record<AgentName, AgentAdapter> = { claude, codex, antigravity };

export const AGENT_NAMES: readonly AgentName[] = ['claude', 'codex', 'antigravity'];

export const AGENT_LABEL: Record<AgentName, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

export const agentLabel = (a: AgentName): string => AGENT_LABEL[a] ?? a;

/**
 * The default partner of an agent when only one side of a pair was chosen: Claude and Codex review each
 * other; Antigravity is paired with Claude. Not a general "the other one" – there are three agents.
 */
export const DEFAULT_PARTNER: Record<AgentName, AgentName> = { claude: 'codex', codex: 'claude', antigravity: 'claude' };

export const defaultPartner = (a: AgentName): AgentName => DEFAULT_PARTNER[a] ?? 'claude';

/** Debate only (Claude × Codex): the opponent. */
export const other = (a: AgentName): AgentName => (a === 'claude' ? 'codex' : 'claude');

export * from './types.ts';
