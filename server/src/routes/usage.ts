import { Hono } from 'hono';
import { paths } from '../paths.ts';
import { RunService, ServiceError } from '../service.ts';
import { getConnection, openLogin, type ConnectionDeps } from '../connection.ts';
import { getUsage, type UsageOptions } from '../usage.ts';

const AGENTS = ['claude', 'codex'] as const;
type TestableAgent = (typeof AGENTS)[number];
const isAgent = (name: string): name is TestableAgent => (AGENTS as readonly string[]).includes(name);

export function usageRoutes(service: RunService, hooks: { connection?: ConnectionDeps; usage?: UsageOptions } = {}): Hono {
  const app = new Hono();

  app.get('/api/usage', async (c) => {
    try {
      return c.json(await getUsage(await service.list(), Date.now(), { ...hooks.usage, force: c.req.query('refresh') === '1' }));
    } catch {
      return c.json({ error: 'Could not read usage' }, 500);
    }
  });

  // Binary, version and login check of one agent; never calls a model.
  app.post('/api/agents/:name/test', async (c) => {
    const name = c.req.param('name');
    if (!isAgent(name)) return c.json({ error: 'agent must be claude or codex' }, 400);
    try {
      const report = await service.preflight([name], paths.defaultCwd);
      const [versions, check] = [await service.agentVersions(), report.checks[0]];
      return c.json({ agent: name, ok: report.ok, problems: report.problems, authUnverified: report.authUnverified, check, version: versions[name] });
    } catch (err) {
      if (err instanceof ServiceError) return c.json({ error: err.message }, err.code === 'invalid' ? 400 : 500);
      return c.json({ error: 'Agent test failed' }, 500);
    }
  });

  // Installed / logged-in state of one CLI; only fixed status commands run.
  app.get('/api/agents/:name/connection', async (c) => {
    const name = c.req.param('name');
    if (!isAgent(name)) return c.json({ error: 'agent must be claude or codex' }, 400);
    try {
      return c.json(await getConnection(name, hooks.connection));
    } catch {
      return c.json({ error: 'Could not read connection status' }, 500);
    }
  });

  // Opens a terminal running the fixed login command; no request data is used besides the agent name.
  app.post('/api/agents/:name/login', async (c) => {
    const name = c.req.param('name');
    if (!isAgent(name)) return c.json({ error: 'agent must be claude or codex' }, 400);
    const outcome = await openLogin(name, hooks.connection).catch(() => 'failed' as const);
    if (outcome === 'notInstalled') return c.json({ error: 'CLI is not installed' }, 409);
    if (outcome === 'failed') return c.json({ error: 'Could not open a terminal' }, 500);
    return c.json({ ok: true });
  });

  return app;
}
