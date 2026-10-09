import { antigravity } from './antigravity.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import type { AgentAdapter, AgentName } from './types.ts';

export const agents: Record<AgentName, AgentAdapter> = { claude, codex, antigravity };

export const other = (a: AgentName): AgentName => (a === 'claude' ? 'codex' : 'claude');

export * from './types.ts';
