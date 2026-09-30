import { Hono } from 'hono';
import { paths } from '../paths.ts';
import { RunService, ServiceError } from '../service.ts';
import { getUsage } from '../usage.ts';

const AGENTS = ['claude', 'codex'] as const;
type TestableAgent = (typeof AGENTS)[number];
const isAgent = (name: string): name is TestableAgent => (AGENTS as readonly string[]).includes(name);

export function usageRoutes(service: RunService): Hono {
  const app = new Hono();

  app.get('/api/usage', async (c) => {
    try {
      return c.json(await getUsage(await service.list()));
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

  return app;
}
