import { Hono, type Context } from 'hono';
import { getPipelines, getRoles, MAX_SETTINGS_BYTES, resetRoles, setPipelines, setRoles } from '../settings.ts';

/**
 * Roles and pipelines (settings.json).
 *   GET  /api/roles            -> { roles }
 *   PUT  /api/roles            body { roles } (or the bare array) -> { roles }
 *   POST /api/roles/reset      -> { roles } (the six defaults)
 *   GET  /api/pipelines        -> { pipelines }
 *   PUT  /api/pipelines        body { pipelines } (or the bare array) -> { pipelines }
 * Errors are `{ error }` with 400 (invalid), 413 (too large) or 415 (not JSON).
 */

type Body = { ok: true; value: unknown } | { ok: false; response: Response };

/** The parsed JSON body, or the error response to send. */
async function readJson(c: Context, key: string): Promise<Body> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return { ok: false, response: c.json({ error: 'Content-Type must be application/json' }, 415) };
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_SETTINGS_BYTES) return { ok: false, response: c.json({ error: 'Body too large' }, 413) };
  const raw = await c.req.text();
  if (raw.length > MAX_SETTINGS_BYTES) return { ok: false, response: c.json({ error: 'Body too large' }, 413) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, response: c.json({ error: 'Body must be valid JSON' }, 400) };
  }
  if (Array.isArray(parsed)) return { ok: true, value: parsed };
  if (typeof parsed === 'object' && parsed !== null && key in parsed) return { ok: true, value: (parsed as Record<string, unknown>)[key] };
  return { ok: false, response: c.json({ error: `Body must be an object with "${key}" or a list` }, 400) };
}

export function rolesRoutes(): Hono {
  const routes = new Hono();

  routes.get('/api/roles', async (c) => c.json({ roles: await getRoles() }));

  routes.put('/api/roles', async (c) => {
    const body = await readJson(c, 'roles');
    if (!body.ok) return body.response;
    const result = await setRoles(body.value);
    return typeof result === 'string' ? c.json({ error: result }, 400) : c.json({ roles: result });
  });

  routes.post('/api/roles/reset', async (c) => c.json({ roles: await resetRoles() }));

  routes.get('/api/pipelines', async (c) => c.json({ pipelines: await getPipelines() }));

  routes.put('/api/pipelines', async (c) => {
    const body = await readJson(c, 'pipelines');
    if (!body.ok) return body.response;
    const result = await setPipelines(body.value);
    return typeof result === 'string' ? c.json({ error: result }, 400) : c.json({ pipelines: result });
  });

  return routes;
}
