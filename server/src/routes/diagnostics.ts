import { Hono } from 'hono';
import { runCheckResults } from '../checks.ts';
import { DirectoryAccessError } from '../project-directories.ts';

/** Runs the project's own static checks (tsc, Biome/ESLint, Ruff) and returns each tool's result. */
export function diagnosticsRoutes(check: typeof runCheckResults = runCheckResults): Hono {
  const app = new Hono();

  app.post('/api/diagnostics', async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : '';
    if (!cwd) return c.json({ error: 'cwd is required' }, 400);
    try {
      const checks = await check(cwd);
      return c.json({ ok: checks.every((r) => r.ok), checks });
    } catch (err) {
      if (err instanceof DirectoryAccessError) return c.json({ error: 'Directory is not available' }, 403);
      return c.json({ error: 'Could not run diagnostics' }, 500);
    }
  });

  return app;
}
