import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentName } from './agents/index.ts';
import { runDebate } from './modes/debate.ts';
import { runPair } from './modes/pair.ts';
import { resolveBin } from './agents/bins.ts';
import { paths } from './paths.ts';
import { active, RunContext } from './run.ts';
import { listRuns, loadRun } from './store.ts';
import type { RunConfig, RunEvent } from './types.ts';

const app = new Hono();
const activePairRepos = new Set<string>();

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

  if (c.req.method === 'POST' && c.req.path === '/api/runs') {
    const contentType = c.req.header('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') return c.json({ error: 'Content-Type must be application/json' }, 415);
  }

  await next();
});

const isAgent = (x: unknown): x is AgentName => x === 'claude' || x === 'codex';

function parseConfig(body: any): RunConfig | string {
  if (body?.mode !== 'debate' && body?.mode !== 'pair') return 'mode must be "debate" or "pair"';
  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) return 'prompt is required';
  const cwd = path.resolve(String(body.cwd ?? '').trim() || paths.defaultCwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return `Working directory not found: ${cwd}`;
  const maxRounds = Math.min(Math.max(Number(body.maxRounds) || (body.mode === 'debate' ? 2 : 3), 1), 8);
  return {
    mode: body.mode,
    prompt,
    cwd,
    maxRounds,
    judge: isAgent(body.judge) ? body.judge : 'claude',
    coder: isAgent(body.coder) ? body.coder : 'codex',
    testCommand: String(body.testCommand ?? '').trim() || undefined,
    turnTimeoutMin: Math.min(Math.max(Number(body.turnTimeoutMin) || 30, 1), 180),
    models: {
      claude: String(body.models?.claude ?? '').trim() || undefined,
      codex: String(body.models?.codex ?? '').trim() || undefined,
    },
  };
}

function version(bin: string): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(bin, ['--version'], { timeout: 15000, windowsHide: true }, (err, out) => resolve(err ? null : out.trim())),
  );
}

app.get('/api/agents', async (c) => {
  const [claude, codex] = await Promise.all([version(resolveBin('claude')), version(resolveBin('codex'))]);
  return c.json({ claude, codex, defaultCwd: paths.defaultCwd });
});

app.get('/api/runs', async (c) => {
  const saved = await listRuns();
  // In-progress runs may not have hit the disk yet.
  for (const ctx of active.values()) {
    if (!saved.some((s) => s.id === ctx.run.id)) {
      const r = ctx.run;
      saved.unshift({ id: r.id, mode: r.config.mode, prompt: r.config.prompt.slice(0, 200), status: r.status, createdAt: r.createdAt });
    }
  }
  return c.json(saved.map((s) => (active.has(s.id) ? { ...s, status: 'running' } : s)));
});

app.get('/api/runs/:id', async (c) => {
  const run = active.get(c.req.param('id'))?.run ?? (await loadRun(c.req.param('id')));
  return run ? c.json(run) : c.json({ error: 'not found' }, 404);
});

app.post('/api/runs', async (c) => {
  const cfg = parseConfig(await c.req.json().catch(() => null));
  if (typeof cfg === 'string') return c.json({ error: cfg }, 400);

  let pairRepoKey: string | undefined;
  if (cfg.mode === 'pair') {
    let repo: string;
    try {
      repo = realpathSync.native(cfg.cwd);
    } catch (err) {
      return c.json({ error: `Cannot resolve working directory: ${(err as Error).message}` }, 400);
    }
    pairRepoKey = process.platform === 'win32' ? repo.toLowerCase() : repo;
    if (activePairRepos.has(pairRepoKey)) return c.json({ error: 'A pair run is already active for this repository' }, 409);
    activePairRepos.add(pairRepoKey);
  }

  const ctx = new RunContext(cfg);
  active.set(ctx.run.id, ctx);
  (async () => {
    let status: 'done' | 'error' | 'cancelled' = 'done';
    let error: string | undefined;
    try {
      await (cfg.mode === 'debate' ? runDebate(ctx) : runPair(ctx));
    } catch (err) {
      status = ctx.cancelled ? 'cancelled' : 'error';
      error = status === 'error' ? (err as Error).message : undefined;
      ctx.abort.abort();
      await Promise.allSettled([...ctx.inflight]);
    }
    try {
      await ctx.finish(status, error);
    } catch (err) {
      console.error(`Failed to save finished run ${ctx.run.id}:`, err);
    } finally {
      active.delete(ctx.run.id);
      if (pairRepoKey) activePairRepos.delete(pairRepoKey);
    }
  })();
  return c.json({ id: ctx.run.id });
});

app.post('/api/runs/:id/cancel', (c) => {
  const ctx = active.get(c.req.param('id'));
  if (!ctx) return c.json({ error: 'run is not active' }, 404);
  ctx.userCancelled = true;
  ctx.abort.abort();
  return c.json({ ok: true });
});

app.get('/api/runs/:id/events', async (c) => {
  const id = c.req.param('id');
  return streamSSE(c, async (stream) => {
    const ctx = active.get(id);
    const send = (e: RunEvent) => stream.writeSSE({ data: JSON.stringify(e) });

    if (!ctx) {
      const run = await loadRun(id);
      if (run) await send({ type: 'snapshot', run });
      return;
    }

    const queue: RunEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = ctx.subscribe((e) => {
      queue.push(e);
      wake?.();
    });
    stream.onAbort(() => {
      unsubscribe();
      wake?.();
    });

    await send({ type: 'snapshot', run: ctx.run });
    let lastPing = Date.now();
    while (!stream.aborted) {
      while (queue.length) await send(queue.shift()!);
      if (ctx.run.status !== 'running') break;
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

/** Kill every running agent process (used on shutdown). */
export function abortAll() {
  for (const ctx of active.values()) {
    // Shutting down is a deliberate stop, not a failure.
    ctx.userCancelled = true;
    ctx.abort.abort();
  }
}
