/**
 * Smoke test for the agent adapters: one turn + one resumed turn per CLI.
 *   pnpm --filter server test:agents [claude|codex]
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agents, type AgentName } from './agents/index.ts';

const only = process.argv[2] as AgentName | undefined;
const cwd = await mkdtemp(path.join(tmpdir(), 'ai-duo-smoke-'));
let failed = false;

for (const name of ['claude', 'codex'] as AgentName[]) {
  if (only && only !== name) continue;
  const agent = agents[name];
  const ac = new AbortController();
  const events: string[] = [];
  const onEvent = (e: { kind: string }) => events.push(e.kind);
  try {
    const t0 = Date.now();
    const r1 = await agent.run({
      prompt: 'Remember the word PINEAPPLE. Reply with exactly: OK',
      cwd,
      role: 'thinker',
      signal: ac.signal,
      onEvent,
      model: name === 'claude' ? 'haiku' : undefined,
    });
    const r2 = await agent.run({
      prompt: 'What word did I ask you to remember? Reply with just the word.',
      cwd,
      role: 'thinker',
      sessionId: r1.sessionId,
      signal: ac.signal,
      onEvent,
      model: name === 'claude' ? 'haiku' : undefined,
    });
    const ok = !!r1.sessionId && /OK/i.test(r1.finalText) && /PINEAPPLE/i.test(r2.finalText);
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s) session=${r1.sessionId} ` +
        `turn1=${JSON.stringify(r1.finalText)} turn2=${JSON.stringify(r2.finalText)} events=${[...new Set(events)].join(',')}`,
    );
    if (!ok) failed = true;
  } catch (err) {
    failed = true;
    console.log(`FAIL ${name}: ${(err as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
