import { Hono, type Context } from 'hono';
import { binVersion } from '../agents/check.ts';
import { resolveBin, type BinSource } from '../agents/bins.ts';
import { getCliSettings, setCliSettings } from '../settings.ts';

/**
 * Per-CLI manual configuration (settings.json).
 *   GET /api/cli-settings              -> { cli }
 *   PUT /api/cli-settings              body { cli } -> { cli }
 *   GET /api/cli-settings/detect/:name -> { name, resolvedPath, source, version, error }
 * Errors are `{ error }` with 400 (invalid), 413 (too large) or 415 (not JSON).
 */

export const MAX_CLI_BODY_BYTES = 64 * 1024;

type Body = { ok: true; value: unknown } | { ok: false; response: Response };

async function readJson(c: Context): Promise<Body> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return { ok: false, response: c.json({ error: 'Content-Type must be application/json' }, 415) };
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_CLI_BODY_BYTES) return { ok: false, response: c.json({ error: 'Body too large' }, 413) };
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > MAX_CLI_BODY_BYTES) return { ok: false, response: c.json({ error: 'Body too large' }, 413) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, response: c.json({ error: 'Body must be valid JSON' }, 400) };
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'cli' in parsed) return { ok: true, value: parsed.cli };
  return { ok: false, response: c.json({ error: 'Body must be an object with "cli"' }, 400) };
}

export interface CliDetection {
  name: 'claude' | 'codex';
  resolvedPath: string | null;
  source: BinSource;
  version: string | null;
  error: string | null;
}

/** What would be launched for `name` right now; runs nothing but `--version`. */
export async function detectCli(name: 'claude' | 'codex'): Promise<CliDetection> {
  try {
    const bin = resolveBin(name);
    if (bin.source === 'none') {
      return { name, resolvedPath: null, source: 'none', version: null, error: `Không tìm thấy ${name} CLI trên PATH hoặc ở các thư mục cài đặt thường gặp.` };
    }
    const { version, error } = await binVersion(bin);
    return { name, resolvedPath: bin.resolvedFrom, source: bin.source, version, error: version ? null : (error ?? 'Không có kết quả từ --version') };
  } catch (err) {
    return { name, resolvedPath: null, source: 'none', version: null, error: (err as Error).message };
  }
}

export function cliSettingsRoutes(): Hono {
  const routes = new Hono();

  routes.get('/api/cli-settings', async (c) => c.json({ cli: await getCliSettings() }));

  routes.put('/api/cli-settings', async (c) => {
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const result = await setCliSettings(body.value);
    return typeof result === 'string' ? c.json({ error: result }, 400) : c.json({ cli: result });
  });

  routes.get('/api/cli-settings/detect/:name', async (c) => {
    const name = c.req.param('name');
    if (name !== 'claude' && name !== 'codex') return c.json({ error: 'name must be claude or codex' }, 400);
    return c.json(await detectCli(name));
  });

  return routes;
}
