import { Hono } from 'hono';
import { listCommands, listSkills } from '../extensions.ts';
import { authorizeDirectory, DirectoryAccessError } from '../project-directories.ts';

/**
 *   GET /api/skills?cwd=   -> { skills }    SKILL.md files of the project and the user
 *   GET /api/commands?cwd= -> { commands }  custom slash commands (markdown prompt templates)
 */
export function extensionsRoutes(): Hono {
  const routes = new Hono();

  const listing = (key: 'skills' | 'commands', load: (cwd: string) => Promise<unknown>) =>
    routes.get(`/api/${key}`, async (c) => {
      const raw = c.req.query('cwd');
      try {
        const cwd = raw ? authorizeDirectory(raw) : undefined;
        if (!cwd) return c.json({ error: 'cwd is required' }, 400);
        return c.json({ [key]: await load(cwd) });
      } catch (err) {
        if (err instanceof DirectoryAccessError) return c.json({ error: 'Directory is not available' }, 403);
        return c.json({ error: `Could not read ${key}` }, 500);
      }
    });

  listing('skills', (cwd) => listSkills(cwd));
  listing('commands', (cwd) => listCommands(cwd));
  return routes;
}
