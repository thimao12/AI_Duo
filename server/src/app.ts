import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentName, Usage } from './agents/index.ts';
import { runDebate } from './modes/debate.ts';
import { runPair } from './modes/pair.ts';
import { agentEnv } from './agents/billing.ts';
import { resolveBin, type ResolvedBin } from './agents/bins.ts';
import { EFFORT, listModels } from './models.ts';
import { paths } from './paths.ts';
import { autoRoute } from './router/index.ts';
import { classifyByRules, CONFIDENT } from './router/rules.ts';
import { active, RunContext } from './run.ts';
import { deleteRun, listRuns, loadRun, saveRun } from './store.ts';
import type { RunConfig, RunEvent } from './types.ts';

const app = new Hono();
const activePairRepos = new Set<string>();
const pendingFollowUps = new Set<string>();
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function parseImages(value: unknown): { images: NonNullable<RunConfig['images']>; buffers: Buffer[] } | string {
  if (value === undefined) return { images: [], buffers: [] };
  if (!Array.isArray(value) || value.length > 4) return 'Choose up to 4 images';
  const images: NonNullable<RunConfig['images']> = [];
  const buffers: Buffer[] = [];
  for (const item of value) {
    if (!item || typeof item.name !== 'string' || typeof item.dataUrl !== 'string') return 'Invalid image';
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.dataUrl);
    if (!match) return 'Use PNG, JPEG, WebP or GIF images';
    if (match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) return 'Each image must be 5 MB or smaller';
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return 'Each image must be 5 MB or smaller';
    const mimeType = match[1];
    const valid = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : mimeType === 'image/jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      : mimeType === 'image/gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!valid) return 'Image contents do not match the selected format';
    images.push({ name: item.name.slice(0, 150), mimeType });
    buffers.push(bytes);
  }
  return { images, buffers };
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

const isAgent = (x: unknown): x is AgentName => x === 'claude' || x === 'codex';

const clampRounds = (n: number) => Math.min(Math.max(n, 1), 8);

/** `mode: "auto"` hands mode, agents, models and (unless given) rounds to the router. */
async function parseConfig(body: any): Promise<{ cfg: RunConfig; routeUsage?: Usage } | string> {
  if (body?.mode !== 'debate' && body?.mode !== 'pair' && body?.mode !== 'plan' && body?.mode !== 'auto') return 'mode must be "auto", "debate", "pair" or "plan"';
  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) return 'prompt is required';
  for (const name of ['claude', 'codex'] as const) {
    const value = body.models?.[name];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `models.${name} must be a valid model name`;
    const model = value.trim();
    if (model && (!/^[\w.:\/-]{1,64}$/.test(model) || model.startsWith('-'))) {
      return `Invalid models.${name}: use 1-64 letters, numbers, or . : / _ - and do not start with -`;
    }
  }
  for (const name of ['claude', 'codex'] as const) {
    const value = body.efforts?.[name];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !EFFORT.test(value)) return `Invalid efforts.${name}: use a level like low, medium or high`;
  }
  const cwd = path.resolve(String(body.cwd ?? '').trim() || paths.defaultCwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return `Working directory not found: ${cwd}`;
  if (body.mode === 'auto') {
    const { route, usage, ...decision } = await autoRoute(prompt);
    const cfg = manualConfig({ ...body, ...decision, maxRounds: Number(body.maxRounds) || decision.maxRounds }, prompt, cwd);
    return { cfg: { ...cfg, route }, routeUsage: usage };
  }
  return { cfg: manualConfig(body, prompt, cwd) };
}

function manualConfig(body: any, prompt: string, cwd: string): RunConfig {
  const maxRounds = clampRounds(Number(body.maxRounds) || (body.mode === 'plan' ? 1 : body.mode === 'debate' ? 2 : 3));
  const coder = isAgent(body.coder) ? body.coder : 'codex';
  return {
    mode: body.mode,
    prompt,
    cwd,
    maxRounds,
    judge: isAgent(body.judge) ? body.judge : 'claude',
    coder,
    reviewer: isAgent(body.reviewer) ? body.reviewer : coder === 'claude' ? 'codex' : 'claude',
    testCommand: String(body.testCommand ?? '').trim() || undefined,
    turnTimeoutMin: Math.min(Math.max(Number(body.turnTimeoutMin) || 30, 1), 180),
    models: {
      claude: String(body.models?.claude ?? '').trim() || undefined,
      codex: String(body.models?.codex ?? '').trim() || undefined,
    },
    efforts: {
      claude: String(body.efforts?.claude ?? '').trim() || undefined,
      codex: String(body.efforts?.codex ?? '').trim() || undefined,
    },
  };
}

function version(bin: ResolvedBin): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(
      bin.cmd,
      [...bin.prefixArgs, '--version'],
      {
        timeout: 15000,
        windowsHide: true,
        shell: false,
        env: agentEnv(bin),
      },
      (err, out) => resolve(err ? null : out.trim()),
    ),
  );
}

async function agentInfo(name: AgentName) {
  try {
    const bin = resolveBin(name);
    return { version: await version(bin), path: bin.resolvedFrom, error: null };
  } catch (err) {
    return { version: null, path: null, error: (err as Error).message };
  }
}

// Models and reasoning levels for the composer's pickers (read fresh: the Codex cache updates itself).
app.get('/api/models', (c) => c.json(listModels()));

app.get('/api/agents', async (c) => {
  const [claude, codex] = await Promise.all([agentInfo('claude'), agentInfo('codex')]);
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

app.get('/api/runs', async (c) => {
  const saved = await listRuns();
  // In-progress runs may not have hit the disk yet.
  for (const ctx of active.values()) {
    if (!saved.some((s) => s.id === ctx.run.id)) {
      const r = ctx.run;
      saved.unshift({ id: r.id, title: r.title, mode: r.config.mode, prompt: r.config.prompt.slice(0, 2000), cwd: r.config.cwd, status: r.status, createdAt: r.createdAt, claudeLimits: r.claudeLimits });
    }
  }
  return c.json(saved.map((s) => (active.has(s.id) ? { ...s, title: active.get(s.id)!.run.title, status: 'running' } : s)));
});

app.get('/api/runs/:id', async (c) => {
  const run = active.get(c.req.param('id'))?.run ?? (await loadRun(c.req.param('id')));
  return run ? c.json(run) : c.json({ error: 'not found' }, 404);
});

app.patch('/api/runs/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (typeof body?.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) return c.json({ error: 'Title must be 1–120 characters' }, 400);
  const run = active.get(id)?.run ?? (await loadRun(id));
  if (!run) return c.json({ error: 'not found' }, 404);
  run.title = body.title.trim();
  await saveRun(run);
  return c.json({ title: run.title });
});

app.delete('/api/runs/:id', async (c) => {
  const id = c.req.param('id');
  if (active.has(id)) return c.json({ error: 'Dừng phiên đang chạy trước khi xóa.' }, 409);
  return (await deleteRun(id)) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

app.get('/api/runs/:id/images/:index', async (c) => {
  const id = c.req.param('id');
  const index = Number(c.req.param('index'));
  if (!/^[\w-]+$/.test(id) || !Number.isSafeInteger(index) || index < 0) return c.json({ error: 'not found' }, 404);
  const run = active.get(id)?.run ?? (await loadRun(id));
  const image = run?.config.images?.[index];
  if (!image || !IMAGE_TYPES[image.mimeType]) return c.json({ error: 'not found' }, 404);
  try {
    const bytes = await readFile(path.join(paths.dataDir, 'images', id, `${index}.${IMAGE_TYPES[image.mimeType]}`));
    return c.body(bytes, 200, { 'content-type': image.mimeType, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

app.get('/api/runs/:id/messages/:messageId/images/:index', async (c) => {
  const { id, messageId } = c.req.param();
  const index = Number(c.req.param('index'));
  if (!/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(messageId) || !Number.isSafeInteger(index) || index < 0) return c.json({ error: 'not found' }, 404);
  const run = active.get(id)?.run ?? (await loadRun(id));
  const image = run?.messages.find((m) => m.id === messageId && m.agent === 'user')?.images?.[index];
  if (!image || !IMAGE_TYPES[image.mimeType]) return c.json({ error: 'not found' }, 404);
  try {
    const bytes = await readFile(path.join(paths.dataDir, 'images', id, `${messageId}-${index}.${IMAGE_TYPES[image.mimeType]}`));
    return c.body(bytes, 200, { 'content-type': image.mimeType, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

/** Rules-only preview for the form: free and instant; says whether Haiku would be asked. */
app.post('/api/route/preview', async (c) => {
  const prompt = String((await c.req.json().catch(() => null))?.prompt ?? '').trim();
  if (!prompt) return c.json({ error: 'prompt is required' }, 400);
  const { route, mode, coder, judge, maxRounds } = await autoRoute(prompt, { classify: false });
  return c.json({ mode, coder, judge, maxRounds, route, askHaiku: classifyByRules(prompt).confidence < CONFIDENT });
});

function launchRun(ctx: RunContext, pairRepoKey?: string) {
  const cfg = ctx.run.config;
  active.set(ctx.run.id, ctx);
  (async () => {
    let status: 'done' | 'error' | 'cancelled' = 'done';
    let error: string | undefined;
    try {
      if (cfg.mode === 'debate') await runDebate(ctx);
      else if (cfg.mode === 'pair') await runPair(ctx);
      else {
        const agent = isAgent(cfg.coder) ? cfg.coder : 'codex';
        const result = await ctx.turn({
          agent, role: 'thinker', phase: 'plan', round: 1,
          title: `${agent === 'claude' ? 'Claude' : 'Codex'} lập kế hoạch`,
          sessionKey: 'plan',
          prompt: `You are a software architect working in read-only planning mode. Inspect the repository at ${cfg.cwd} as needed. Do not edit files or run commands that modify data. Create a concrete implementation plan for this task:\n\n${ctx.prompt}\n\nReturn a concise plan with: current context and relevant files, ordered implementation steps, edge cases or risks, and how to verify the work. Do not implement the changes.`,
        });
        ctx.update({ final: result.text });
      }
      if (ctx.cancelled) status = 'cancelled';
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
}

app.post('/api/runs', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsedImages = parseImages(body?.images);
  if (typeof parsedImages === 'string') return c.json({ error: parsedImages }, 400);
  const parsed = await parseConfig(parsedImages.images.length && !String(body?.prompt ?? '').trim() ? { ...body, prompt: 'Hãy phân tích ảnh đính kèm.' } : body);
  if (typeof parsed === 'string') return c.json({ error: parsed }, 400);
  const { cfg, routeUsage } = parsed;
  if (parsedImages.images.length) cfg.images = parsedImages.images;

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
  if (parsedImages.buffers.length) {
    const dir = path.join(paths.dataDir, 'images', ctx.run.id);
    try {
      await mkdir(dir, { recursive: true });
      await Promise.all(parsedImages.buffers.map((bytes, index) => writeFile(path.join(dir, `${index}.${IMAGE_TYPES[parsedImages.images[index].mimeType]}`), bytes)));
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      if (pairRepoKey) activePairRepos.delete(pairRepoKey);
      return c.json({ error: `Could not save images: ${(err as Error).message}` }, 500);
    }
  }
  if (cfg.route) {
    const manual = Object.entries(cfg.models ?? {}).filter(([, m]) => m);
    const override = manual.length ? `\nModel đặt tay (ưu tiên hơn router): ${manual.map(([a, m]) => `${a}=${m}`).join(', ')}` : '';
    ctx.note('Định tuyến tự động', cfg.route.reason + override, 'info', 0, routeUsage);
  }
  launchRun(ctx, pairRepoKey);
  return c.json({ id: ctx.run.id });
});

app.post('/api/runs/:id/messages', async (c) => {
  const id = c.req.param('id');
  if (!/^[\w-]+$/.test(id)) return c.json({ error: 'not found' }, 404);
  if (active.has(id) || pendingFollowUps.has(id)) return c.json({ error: 'Phiên đang chạy, hãy đợi hoàn tất.' }, 409);
  pendingFollowUps.add(id);
  let pairRepoKey: string | undefined;
  try {
    const body = await c.req.json().catch(() => null);
    const parsedImages = parseImages(body?.images);
    if (typeof parsedImages === 'string') return c.json({ error: parsedImages }, 400);
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt && !parsedImages.images.length) return c.json({ error: 'prompt is required' }, 400);
    const run = await loadRun(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    if (active.has(id)) return c.json({ error: 'Phiên đang chạy, hãy đợi hoàn tất.' }, 409);
    const nextPrompt = prompt || 'Hãy phân tích ảnh đính kèm.';
    if (body?.mode !== undefined && body.mode !== 'auto' && body.mode !== 'pair' && body.mode !== 'debate' && body.mode !== 'plan') return c.json({ error: 'Invalid mode' }, 400);
    const manualMode = body?.mode === 'pair' || body?.mode === 'debate' || body?.mode === 'plan' ? body.mode : null;
    const parsedOptions = await parseConfig({ ...body, mode: manualMode ?? 'plan', cwd: run.config.cwd, prompt: nextPrompt });
    if (typeof parsedOptions === 'string') return c.json({ error: parsedOptions }, 400);
    const { models, efforts, testCommand, turnTimeoutMin } = parsedOptions.cfg;
    let routeUsage: Usage | undefined;
    if (manualMode) {
      run.config = {
        ...run.config,
        ...parsedOptions.cfg,
        prompt: run.config.prompt,
        cwd: run.config.cwd,
        images: run.config.images,
        route: undefined,
      };
    } else {
      const decision = await autoRoute(nextPrompt);
      routeUsage = decision.usage;
      run.config = {
        ...run.config,
        mode: decision.mode,
        coder: decision.coder,
        reviewer: decision.reviewer,
        judge: decision.judge,
        maxRounds: decision.maxRounds,
        route: decision.route,
        models,
        efforts,
        testCommand,
        turnTimeoutMin,
      };
    }
    if (run.config.mode === 'pair') {
      const repo = realpathSync.native(run.config.cwd);
      pairRepoKey = process.platform === 'win32' ? repo.toLowerCase() : repo;
      if (activePairRepos.has(pairRepoKey)) return c.json({ error: 'A pair run is already active for this repository' }, 409);
      activePairRepos.add(pairRepoKey);
    }
    const messageId = randomUUID();
    if (parsedImages.buffers.length) {
      const dir = path.join(paths.dataDir, 'images', id);
      await mkdir(dir, { recursive: true });
      try {
        await Promise.all(parsedImages.buffers.map((bytes, index) => writeFile(path.join(dir, `${messageId}-${index}.${IMAGE_TYPES[parsedImages.images[index].mimeType]}`), bytes)));
      } catch (err) {
        await Promise.all(parsedImages.buffers.map((_, index) => rm(path.join(dir, `${messageId}-${index}.${IMAGE_TYPES[parsedImages.images[index].mimeType]}`), { force: true }).catch(() => {})));
        throw err;
      }
    }
    const ctx = new RunContext(run.config, run);
    ctx.followUp(nextPrompt, parsedImages.images, messageId);
    if (run.config.route) {
      const manual = Object.entries(run.config.models ?? {}).filter(([, model]) => model);
      const override = manual.length ? `\nModel đặt tay (ưu tiên hơn router): ${manual.map(([agent, model]) => `${agent}=${model}`).join(', ')}` : '';
      ctx.note('Định tuyến tự động', run.config.route.reason + override, 'info', 0, routeUsage);
    }
    launchRun(ctx, pairRepoKey);
    return c.json({ id });
  } catch (err) {
    if (pairRepoKey) activePairRepos.delete(pairRepoKey);
    return c.json({ error: `Could not continue run: ${(err as Error).message}` }, 500);
  } finally {
    pendingFollowUps.delete(id);
  }
});

app.post('/api/runs/:id/cancel', (c) => {
  const ctx = active.get(c.req.param('id'));
  if (!ctx) return c.json({ error: 'run is not active' }, 404);
  ctx.userCancelled = true;
  ctx.abort.abort();
  return c.json({ ok: true });
});

app.post('/api/runs/:id/pair-decision', async (c) => {
  const ctx = active.get(c.req.param('id'));
  if (!ctx?.run.pairDecision) return c.json({ error: 'no Pair decision is waiting' }, 409);
  const body = await c.req.json().catch(() => null);
  if (typeof body?.continue !== 'boolean') return c.json({ error: 'continue must be a boolean' }, 400);
  if (!ctx.answerPairDecision(body.continue)) return c.json({ error: 'Pair decision is no longer waiting' }, 409);
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
