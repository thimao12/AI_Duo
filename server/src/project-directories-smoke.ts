import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectoryAccessError, ProjectDirectories } from './project-directories.ts';
import type { Run } from './types.ts';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo allowed roots '));
const allowed = path.join(temp, 'project');
const outside = path.join(temp, 'project-extra');
const sub = path.join(allowed, 'folder with spaces');
await Promise.all([mkdir(sub, { recursive: true }), mkdir(outside)]);
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([allowed]);

try {
  const policy = new ProjectDirectories(undefined, allowed);
  assert.equal(policy.resolve(allowed), fs.realpathSync.native(allowed));
  assert.equal(policy.resolve(sub), fs.realpathSync.native(sub));
  if (process.platform === 'win32') assert.equal(policy.resolve(sub.toUpperCase()), fs.realpathSync.native(sub));
  for (const cwd of [outside, temp, path.join(allowed, '..', 'project-extra'), '', `${sub}\u0000`]) {
    assert.throws(() => policy.resolve(cwd), DirectoryAccessError);
  }
  const fixture = path.join(allowed, 'file.txt');
  await writeFile(fixture, 'unchanged');
  assert.throws(() => policy.resolve(fixture), /not a directory/);
  assert.throws(() => policy.resolve(path.join(allowed, 'missing')), /not found/);
  for (const config of ['oops', '{}', 'null', '["relative"]', '[2]', JSON.stringify([path.join(temp, 'missing')]), JSON.stringify([fixture])]) {
    assert.throws(() => new ProjectDirectories(config, allowed), /AI_DUO_ALLOWED_ROOTS/);
  }
  assert.throws(() => new ProjectDirectories('[]', allowed).resolve(allowed), /outside/);
  const escape = path.join(allowed, 'escape');
  await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => policy.resolve(escape), /resolves outside/);
  const alias = path.join(temp, 'project-alias');
  await symlink(allowed, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(new ProjectDirectories(JSON.stringify([alias]), temp).resolve(path.join(alias, 'folder with spaces')), fs.realpathSync.native(sub));

  const [{ RunService, ServiceError }, { agents }, { saveRun }, git, { RunContext }] = await Promise.all([
    import('./service.ts'), import('./agents/index.ts'), import('./store.ts'), import('./git.ts'), import('./run.ts'),
  ]);
  const originals = { claude: { ...agents.claude }, codex: { ...agents.codex } };
  let checks = 0;
  let turns = 0;
  let classifications = 0;
  const service = new RunService({
    app: 'roots-smoke',
    checkAgent: (agent) => { checks++; return Promise.resolve({ agent, path: agent, version: 'fake', auth: 'ok' }); },
    classify: () => { classifications++; return Promise.resolve({ taskType: 'edit', complexity: 'light' }); },
  });
  for (const agent of ['claude', 'codex'] as const) agents[agent].run = (options) => {
    turns++;
    assert.equal(options.cwd, fs.realpathSync.native(sub));
    return Promise.resolve({ finalText: options.prompt.includes('Review this proposed implementation plan') ? 'PLAN_VERDICT: APPROVE' : 'Plan: inspect and verify.' });
  };
  const invalid = (err: unknown) => err instanceof ServiceError && err.code === 'invalid' && /AI_DUO_ALLOWED_ROOTS/.test(err.message);
  const old: Run = {
    id: 'old-outside-run', status: 'done', createdAt: Date.now(), messages: [], final: 'Previous result',
    config: { mode: 'plan', prompt: 'previous task', cwd: outside, coder: 'codex', judge: 'claude', maxRounds: 2, turnTimeoutMin: 30 },
  };
  await saveRun(old);
  assert.equal((await service.get(old.id))?.final, 'Previous result');
  assert.ok((await service.list()).some((run) => run.id === old.id));

  // Instrument the actual Node sinks: rejected input must not probe a project or launch Git.
  const originalExec = childProcess.execFile;
  const originalRealpath = fs.realpathSync.native;
  const probes: string[] = [];
  let gitCalls = 0;
  childProcess.execFile = ((...args: Parameters<typeof originalExec>) => {
    if (args[0] === 'git') gitCalls++;
    return originalExec(...args);
  }) as typeof originalExec;
  fs.realpathSync.native = ((...args: Parameters<typeof originalRealpath>) => {
    probes.push(String(args[0]));
    return originalRealpath(...args);
  }) as typeof originalRealpath;
  syncBuiltinESMExports();
  try {
    await assert.rejects(service.start({ mode: 'code', prompt: 'Implement a change', cwd: outside }), invalid);
    await assert.rejects(service.preflight(['claude'], outside), invalid);
    await assert.rejects(service.continue(old.id, { prompt: 'Continue', cwd: allowed, mode: 'plan' }), invalid);
    assert.equal(await git.isGitRepo(outside), false);
    assert.equal(gitCalls, 0, 'rejected requests never launch Git');
    assert.deepEqual(probes, [], 'lexically forbidden projects are rejected before realpath');
    await assert.rejects(service.start({ mode: 'plan', prompt: 'Plan a change', cwd: escape }), invalid);
    assert.equal(gitCalls, 0, 'an escaping symlink never reaches Git');
    assert.equal(checks + turns + classifications, 0, 'invalid paths never reach preflight, routing or agents');
  } finally {
    childProcess.execFile = originalExec;
    fs.realpathSync.native = originalRealpath;
    syncBuiltinESMExports();
  }

  // A subfolder of a repository cannot grant permission to snapshot its forbidden parent.
  childProcess.execFileSync(git.gitExecutable(), ['init', '-q'], { cwd: temp });
  assert.equal(await git.gitToplevel(allowed), null);
  await assert.rejects(git.snapshotTree(allowed), /inside AI_DUO_ALLOWED_ROOTS/);
  const { lockTarget } = await import('./lock.ts');
  const projectLock = await lockTarget(allowed);
  assert.equal(projectLock.root, fs.realpathSync.native(temp));
  assert.equal((await lockTarget(sub)).file, projectLock.file, 'restricted Plan folders still share their repository lock');
  await rm(path.join(temp, '.git'), { recursive: true, force: true });

  let handle: Awaited<ReturnType<typeof service.start>> | undefined;
  try {
    handle = await service.start({ mode: 'plan', cwd: sub, prompt: 'Implement and add a settings panel' });
    const deadline = Date.now() + 10_000;
    while (!handle.run.planDecision) {
      assert.equal(handle.run.status, 'running', handle.run.error);
      if (Date.now() > deadline) assert.fail('Plan decision timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const callsBeforeApproval = turns;
    await rename(sub, `${sub}-original`);
    await symlink(outside, sub, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(handle.answerPlanDecision({ action: 'approve' }), invalid);
    assert.ok(handle.run.planDecision, 'rejected approval keeps the plan waiting');
    assert.equal(handle.run.config.mode, 'plan');
    assert.equal(turns, callsBeforeApproval);
    // Each turn rechecks authorization even when its config came from a saved run.
    const ctx = new RunContext({ ...old.config, cwd: sub });
    await assert.rejects(ctx.turn({ agent: 'claude', role: 'thinker', prompt: 'x', phase: 'plan', round: 1, title: 'test' }), /resolves outside/);
    await ctx.finish('error', 'Expected denied directory');
    assert.equal(turns, callsBeforeApproval);
    handle.cancel();
    assert.equal((await handle.done).status, 'cancelled');
  } finally {
    handle?.cancel();
    await handle?.done;
    Object.assign(agents.claude, originals.claude);
    Object.assign(agents.codex, originals.codex);
  }
  assert.equal(await readFile(fixture, 'utf8'), 'unchanged');
  console.log('PASS allowed project roots, startup configuration, symlinks, Git boundaries, old runs and Plan approval');
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
