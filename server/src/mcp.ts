import type { Role } from './agents/types.ts';
import { getCliSettingsSync } from './settings.ts';
import type { McpServer } from './types.ts';

/** An explicit permission replaces the role's tier: edit = coder, read = reviewer (if it was one) or thinker. */
export function tierFor(role: Role, permission?: 'read' | 'edit'): Role {
  if (permission === 'edit') return 'coder';
  if (permission === 'read') return role === 'reviewer' ? 'reviewer' : 'thinker';
  return role;
}

/** MCP servers a turn of `tier` may use; a server without `roles` is for the coder only. */
export function mcpServersFor(tier: Role, servers: readonly McpServer[] = getCliSettingsSync().mcp ?? []): McpServer[] {
  return servers.filter((s) => (s.roles ?? ['coder']).includes(tier));
}

/** `--mcp-config` as inline JSON; the matching `mcp__<name>` allowlist entries come from the same servers. */
export function claudeMcpArgs(servers: readonly McpServer[]): string[] {
  if (!servers.length) return [];
  const mcpServers = Object.fromEntries(servers.map((s) => [s.name, { command: s.command, args: s.args ?? [], ...(s.env && { env: s.env }) }]));
  return ['--mcp-config', JSON.stringify({ mcpServers })];
}

export const claudeMcpTools = (servers: readonly McpServer[]): string[] => servers.map((s) => `mcp__${s.name}`);

/** Codex takes servers as `-c mcp_servers.<name>.*` overrides; JSON strings and arrays are valid TOML values. */
export function codexMcpArgs(servers: readonly McpServer[]): string[] {
  const args: string[] = [];
  for (const s of servers) {
    const key = `mcp_servers.${s.name}`;
    args.push('-c', `${key}.command=${JSON.stringify(s.command)}`);
    if (s.args?.length) args.push('-c', `${key}.args=${JSON.stringify(s.args)}`);
    if (s.env) args.push('-c', `${key}.env={${Object.entries(s.env).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(', ')}}`);
  }
  return args;
}
