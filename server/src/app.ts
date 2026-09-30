import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { listModels } from './models.ts';
import { paths } from './paths.ts';
import { isDataId, readRunImage } from './data-path.ts';
import { IMAGE_TYPES, RunService, ServiceError, type ServiceErrorCode } from './service.ts';
import { loadRun } from './store.ts';
import type { RunEvent } from './types.ts';

const app = new Hono();
/** Web and desktop share this service with the CLI; `app` labels the lock files it creates. */
export const service = new RunService({ app: process.versions.electron ? 'desktop' : 'server' });

const STATUS: Record<ServiceErrorCode, 400 | 404 | 409 | 424 | 500> = { invalid: 400, not_found: 404, conflict: 409, preflight: 424, internal: 500 };

/** Maps service failures to JSON errors; anything else is a bug and stays a 500. */
async function handle(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceError) return c.json({ error: err.message, ...(err.details.preflight && { preflight: err.details.preflight }) }, STATUS[err.code]);
    throw err;
  }
}

const defaultDevOrigins = 'http://localhost:5173,http://127.0.0.1:5173';

function isLocalHost(host: string): boolean {
  try {
    const url = new URL(`http://${host}`);
    return (
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

app.use('/api/*', async (c, next) => {
  const host = c.req.header('host') ?? '';
  if (!isLocalHost(host)) return c.json({ error: 'Host must be localhost or 127.0.0.1' }, 403);

  const origin = c.req.header('origin');
  if (origin !== undefined) {
    const devOrigins = (process.env.AI_DUO_DEV_ORIGINS ?? defaultDevOrigins)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (origin !== `http://${host}` && !devOrigins.includes(origin)) {
      return c.json({ error: 'Origin is not allowed' }, 403);
    }
  }

  if (c.req.method === 'POST' && (c.req.path === '/api/runs' || c.req.path === '/api/route/preview')) {
    const contentType = c.req.header('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') return c.json({ error: 'Content-Type must be application/json' }, 415);
  }

  await next();
});

// Models and reasoning levels for the composer's pickers (read fresh: the Codex cache updates itself).
app.get('/api/models', (c) => c.json(listModels()));

app.get('/api/agents', async (c) => {
  const { claude, codex } = await service.agentVersions();
  return c.json({
    claude: claude.version,
    codex: codex.version,
    claudePath: claude.path,
    codexPath: codex.path,
    claudeError: claude.error,
    codexError: codex.error,
    defaultCwd: paths.defaultCwd,
  });
});

app.get('/api/runs', async (c) => c.json(await service.list()));

app.get('/api/runs/:id', async (c) => {
  const run = await service.get(c.req.param('id'));
  return run ? c.json(run) : c.json({ error: 'not found' }, 404);
});

app.patch('/api/runs/:id', (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => null);
    return c.json({ title: await service.rename(c.req.param('id'), body?.title) });
  }),
);

app.delete('/api/runs/:id', (c) =>
  handle(c, async () => {
    await service.delete(c.req.param('id'));
    return c.json({ ok: true });
  }),
);

app.get('/api/runs/:id/images/:index', async (c) => {
  const id = c.req.param('id');
  const index = Number(c.req.param('index'));
  if (!isDataId(id) || !Number.isSafeInteger(index) || index < 0) return c.json({ error: 'not found' }, 404);
  const run = await service.get(id);
  const image = run?.config.images?.[index];
  if (!image || !Object.hasOwn(IMAGE_TYPES, image.mimeType)) return c.json({ error: 'not found' }, 404);
  try {
    const bytes = await readRunImage(id, index, image.mimeType);
    return c.body(bytes, 200, { 'content-type': image.mimeType, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

app.get('/api/runs/:id/messages/:messageId/images/:index', async (c) => {
  const { id, messageId } = c.req.param();
  const index = Number(c.req.param('index'));
  if (!isDataId(id) || !isDataId(messageId) || !Number.isSafeInteger(index) || index < 0) return c.json({ error: 'not found' }, 404);
  const run = await service.get(id);
  const image = run?.messages.find((m) => m.id === messageId && m.agent === 'user')?.images?.[index];
  if (!image || !Object.hasOwn(IMAGE_TYPES, image.mimeType)) return c.json({ error: 'not found' }, 404);
  try {
    const bytes = await readRunImage(id, index, image.mimeType, messageId);
    return c.body(bytes, 200, { 'content-type': image.mimeType, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

/** Rules-only preview for the form: free and instant; says whether Haiku would be asked. */
app.post('/api/route/preview', (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => null);
    return c.json(await service.previewRoute(body?.prompt, body?.mode));
  }),
);

app.post('/api/runs', (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => null);
    const { id } = await service.start(body);
    return c.json({ id });
  }),
);

app.post('/api/runs/:id/messages', (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => null);
    const { id } = await service.continue(c.req.param('id'), body);
    return c.json({ id });
  }),
);

app.post('/api/runs/:id/cancel', async (c) => {
  const id = c.req.param('id');
  if (service.cancel(id)) return c.json({ ok: true });
  const owner = await service.activeElsewhere(id);
  // Stopping another process's run needs inter-process messaging, which does not exist yet.
  if (owner) return c.json({ error: `Phiên này đang chạy ở tiến trình khác (${owner.app}, PID ${owner.pid}); hãy dừng nó từ đó.` }, 409);
  return c.json({ error: 'run is not active' }, 404);
});

app.post('/api/runs/:id/pair-decision', (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => null);
    service.answerPairDecision(c.req.param('id'), body);
    return c.json({ ok: true });
  }),
);

app.post('/api/runs/:id/plan-decision', (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => null);
    await service.answerPlanDecision(c.req.param('id'), body);
    return c.json({ ok: true });
  }),
);

app.get('/api/runs/:id/events', async (c) => {
  const id = c.req.param('id');
  return streamSSE(c, async (stream) => {
    const run = service.handle(id);
    const send = (e: RunEvent) => stream.writeSSE({ data: JSON.stringify(e) });

    if (!run) {
      let saved = await loadRun(id);
      if (saved) await send({ type: 'snapshot', run: saved });
      // Still "running" on disk only while another process (CLI, desktop) runs it: follow its checkpoints.
      let last = JSON.stringify(saved);
      let lastPing = Date.now();
      while (saved?.status === 'running' && !stream.aborted) {
        await stream.sleep(1500);
        saved = await loadRun(id);
        const text = JSON.stringify(saved);
        if (saved && text !== last) {
          await send({ type: 'snapshot', run: saved });
          last = text;
        } else if (Date.now() - lastPing > 14000) {
          await stream.writeSSE({ event: 'ping', data: '' });
          lastPing = Date.now();
        }
      }
      return;
    }

    const queue: RunEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = run.subscribe((e) => {
      queue.push(e);
      wake?.();
    });
    stream.onAbort(() => {
      unsubscribe();
      wake?.();
    });

    await send({ type: 'snapshot', run: run.run });
    let lastPing = Date.now();
    while (!stream.aborted) {
      while (queue.length) await send(queue.shift()!);
      if (run.run.status !== 'running') break;
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 15000);
      });
      wake = undefined;
      if (Date.now() - lastPing > 14000) {
        await stream.writeSSE({ event: 'ping', data: '' });
        lastPing = Date.now();
      }
    }
    unsubscribe();
  });
});


// Serve the built web UI (production / desktop).
if (existsSync(paths.webDist)) {
  app.use('/*', serveStatic({ root: paths.webDist }));
  app.get('*', serveStatic({ path: path.join(paths.webDist, 'index.html') }));
}

export interface StartOptions {
  port: number;
  host?: string;
  /** If the port is taken, fall back to any free port instead of failing. */
  fallbackPort?: boolean;
}

export function startServer({ port, host = '127.0.0.1', fallbackPort = false }: StartOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createAdaptorServer({ fetch: app.fetch });
  const listen = (p: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, host, () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  return listen(port)
    .catch((err: NodeJS.ErrnoException) => {
      if (fallbackPort && err.code === 'EADDRINUSE') return listen(0);
      throw err;
    })
    .then((p) => ({
      url: `http://${host}:${p}`,
      close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    }));
}

/**
 * Kill every running agent process (used on shutdown). Resolves once each run is saved and has
 * released its repository lock, so callers should wait (with a timeout) before exiting.
 */
export function abortAll(): Promise<void> {
  return service.abortAll();
}
