/** Smoke checks for fail-closed pair review handling. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agents } from './agents/index.ts';
import { diffTreeSummary, snapshotTree } from './git.ts';
import type { RunContext as RunContextType } from './run.ts';

const dataDir = await mkdtemp(path.join(tmpdir(), 'ai-duo-pair-review-runs-'));
process.env.AI_DUO_DATA_DIR = dataDir;
const [{ parseReview, runPair }, { RunContext }] = await Promise.all([import('./modes/pair.ts'), import('./run.ts')]);

function fencedReview(verdict: string, extra = '') {
  return `\`\`\`json\n{"verdict":"${verdict}"${extra}}\n\`\`\``;
}

assert.equal(parseReview(fencedReview('NOT_APPROVED')).verdict, undefined);
assert.equal(parseReview(fencedReview('DISAPPROVE')).verdict, undefined);
assert.equal(parseReview('I would not APPROVE this').verdict, undefined);
assert.equal(parseReview('```json\n{"verdict":\n```').verdict, undefined);
assert.equal(parseReview('{"verdict":"APPROVE"}').verdict, undefined, 'unfenced JSON must not count');

const malformedIssues = parseReview(fencedReview('APPROVE', ',"issues":"x","tests":123'));
assert.equal(malformedIssues.verdict, 'APPROVE');
assert.deepEqual(malformedIssues.issues, []);
  assert.equal(malformedIssues.tests, undefined);

  const tempRepos: string[] = [];

async function makeRepo() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ai-duo-pair-review-'));
  tempRepos.push(cwd);
  execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'pair-smoke@example.invalid'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Pair Smoke'], { cwd, stdio: 'ignore' });
  await writeFile(path.join(cwd, 'reviewer.txt'), 'baseline\n');
  execFileSync('git', ['add', 'reviewer.txt'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd, stdio: 'ignore' });
  return cwd;
}

function fakeContext(cwd: string, coder: 'claude' | 'codex', maxRounds: number, respond: (turn: any) => Promise<string>) {
  const notes: { title: string; text: string }[] = [];
  const updates: Record<string, unknown>[] = [];
  const turns: { phase: string; prompt: string; verdict?: string }[] = [];
  const ctx = {
    run: { config: { mode: 'pair', cwd, prompt: 'smoke task', maxRounds, coder, judge: 'claude', turnTimeoutMin: 1 } },
    note: (title: string, text: string) => notes.push({ title, text }),
    update: (patch: Record<string, unknown>) => updates.push(patch),
    turn: async (turn: { phase: string; prompt: string; parseVerdict?: (text: string) => string | undefined | Promise<string | undefined> }) => {
      const text = await respond(turn);
      const verdict = await turn.parseVerdict?.(text);
      turns.push({ ...turn, verdict });
      return { text, verdict };
    },
  } as unknown as RunContextType;
  return { ctx, notes, updates, turns };
}

try {
  const originalClaudeRun = agents.claude.run;
  try {
    agents.claude.run = async () => ({ finalText: 'review complete' });
    const run = new RunContext({ mode: 'pair', cwd: process.cwd(), prompt: 'smoke', maxRounds: 1, judge: 'claude', coder: 'codex', turnTimeoutMin: 1 });
    (run as any).scheduleSave = () => {};
    const events: { type: string; verdict?: string }[] = [];
    run.subscribe((event) => {
      if (event.type === 'message.end') events.push(event);
    });
    const turn = await run.turn({
      agent: 'claude',
      role: 'reviewer',
      prompt: 'smoke',
      phase: 'review',
      round: 1,
      title: 'review',
      parseVerdict: async () => {
        await Promise.resolve();
        return 'CHANGES_REQUESTED' as const;
      },
    });
    assert.equal(turn.verdict, 'CHANGES_REQUESTED');
    assert.equal(run.run.messages[0].verdict, 'CHANGES_REQUESTED');
    assert.equal(events[0].verdict, 'CHANGES_REQUESTED');
    await run.finish('done');
  } finally {
    agents.claude.run = originalClaudeRun;
  }

  const renameRepo = await makeRepo();
  execFileSync('git', ['config', 'color.ui', 'always'], { cwd: renameRepo, stdio: 'ignore' });
  execFileSync('git', ['config', 'diff.renames', 'true'], { cwd: renameRepo, stdio: 'ignore' });
  const beforeRename = await snapshotTree(renameRepo);
  await rename(path.join(renameRepo, 'reviewer.txt'), path.join(renameRepo, 'renamed.txt'));
  const afterRename = await snapshotTree(renameRepo);
  const renameSummary = await diffTreeSummary(renameRepo, beforeRename, afterRename);
  assert.deepEqual(renameSummary.files.sort(), ['renamed.txt', 'reviewer.txt']);
  assert.doesNotMatch(renameSummary.stat, /\x1b/);

  // Malformed issue data must be normalized, not crash final issue rendering.
  const approvalRepo = await makeRepo();
  const approval = fakeContext(approvalRepo, 'claude', 1, async (turn) => {
    if (turn.phase === 'code') {
      await writeFile(path.join(approvalRepo, 'output.txt'), 'implemented\n');
      return 'Implemented.';
    }
    return fencedReview('APPROVE', ',"issues":"x"');
  });
  await runPair(approval.ctx);
  assert.match(String(approval.updates.at(-1)?.final), /Approved by Codex/);
  assert.equal(approval.turns.find((turn) => turn.phase === 'review')?.verdict, 'APPROVE');
  assert.equal(approval.notes.some((note) => note.title === 'Reviewer không trả verdict hợp lệ'), false);

  const invalidRepo = await makeRepo();
  const invalid = fakeContext(invalidRepo, 'claude', 1, async (turn) =>
    turn.phase === 'review' ? 'I would not APPROVE this' : 'Implemented.',
  );
  await runPair(invalid.ctx);
  assert.match(String(invalid.updates.at(-1)?.final), /Not approved after 1 review round/);
  assert.equal(invalid.turns.find((turn) => turn.phase === 'review')?.verdict, 'CHANGES_REQUESTED');
  assert.ok(invalid.notes.some(({ title, text }) => title === 'Reviewer không trả verdict hợp lệ' && text === '→ coi như CHANGES_REQUESTED'));

  // Both reviewer identities are watched. Their tracked writes warn, block approval,
  // and are named explicitly in the next coder fix prompt.
  for (const coder of ['claude', 'codex'] as const) {
    const cwd = await makeRepo();
    let reviewRound = 0;
    const mutation = fakeContext(cwd, coder, 2, async (turn) => {
      if (turn.phase === 'code') return 'Implemented.';
      if (turn.phase === 'fix') return 'Processed review.';
      reviewRound++;
      await writeFile(path.join(cwd, 'reviewer.txt'), `reviewer write ${reviewRound}\n`);
      return fencedReview('APPROVE');
    });
    await runPair(mutation.ctx);
    const final = String(mutation.updates.at(-1)?.final);
    assert.match(final, /Not approved after 2 review round/);
    assert.equal(reviewRound, 2);
    assert.ok(mutation.notes.some(({ title, text }) => title === 'Reviewer đã sửa tệp trong lượt đánh giá' && /git diff --stat/.test(text) && /reviewer\.txt/.test(text)));
    assert.ok(mutation.turns.filter((turn) => turn.phase === 'review').every((turn) => turn.verdict === 'CHANGES_REQUESTED'));
    const fixPrompt = mutation.turns.find((turn) => turn.phase === 'fix')?.prompt ?? '';
    assert.match(fixPrompt, /reviewer\.txt/);
    assert.match(fixPrompt, /CHANGES_REQUESTED/);
  }

  console.log('PASS strict review parsing, normalized issues, and fail-closed reviewer write detection for both agents');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await Promise.all(tempRepos.map((cwd) => rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error)));
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(console.error);
}
