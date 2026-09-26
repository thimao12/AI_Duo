import { other, type AgentName } from '../agents/index.ts';
import { diffSince, isGitRepo, snapshotTree } from '../git.ts';
import { render } from '../prompts/index.ts';
import type { RunContext } from '../run.ts';
import type { Verdict } from '../types.ts';

const label = (a: AgentName) => (a === 'claude' ? 'Claude' : 'Codex');
const MAX_DIFF_CHARS = 60_000;

export interface ReviewResult {
  verdict?: 'APPROVE' | 'CHANGES_REQUESTED';
  tests?: string;
  issues?: { severity?: string; file?: string; description?: string }[];
}

export function parseReview(text: string): ReviewResult {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of blocks.reverse()) {
    try {
      const obj = JSON.parse(b);
      if (obj && typeof obj.verdict === 'string') {
        const v = obj.verdict.toUpperCase();
        return { ...obj, verdict: v.includes('APPROVE') ? 'APPROVE' : 'CHANGES_REQUESTED' };
      }
    } catch {}
  }
  // Fallback when the JSON block is missing or malformed.
  if (/CHANGES_REQUESTED/i.test(text)) return { verdict: 'CHANGES_REQUESTED' };
  if (/\bAPPROVE\b/i.test(text)) return { verdict: 'APPROVE' };
  return {};
}

function formatDiff(diff: string) {
  if (!diff.trim()) return '_(no changes detected)_';
  const cut = diff.length > MAX_DIFF_CHARS;
  return '```diff\n' + (cut ? diff.slice(0, MAX_DIFF_CHARS) : diff) + '\n```' + (cut ? '\n(diff truncated – inspect the files directly for the rest)' : '');
}

/**
 * coder implements → reviewer reviews diff + runs tests → coder fixes → … until APPROVE or maxRounds.
 * Nothing is committed; the final diff is shown to the user.
 */
export async function runPair(ctx: RunContext) {
  const { prompt, cwd, maxRounds, coder, testCommand } = ctx.run.config;
  const reviewer = other(coder);

  if (!(await isGitRepo(cwd))) {
    throw new Error(`Pair mode needs a git repository so changes can be diffed and reverted. "${cwd}" is not one (run \`git init\` there first).`);
  }
  const base = await snapshotTree(cwd);
  ctx.note('Baseline captured', `Snapshot of the working tree taken (tree ${base.slice(0, 10)}). The diff at the end shows only what the agents changed. Nothing will be committed.`);

  const testHint = testCommand
    ? `Run \`${testCommand}\` to verify.`
    : 'Detect and run the project\'s relevant test / type-check / build commands (e.g. from package.json, Makefile, pyproject). If there are none, do a focused manual check.';

  let summary = (
    await ctx.turn({
      agent: coder,
      role: 'coder',
      sessionKey: 'coder',
      phase: 'code',
      round: 1,
      title: `${label(coder)} implements`,
      prompt: render('code', { peer: label(reviewer), cwd, prompt, testHint }),
    })
  ).text;

  let approved = false;
  let lastReview: ReviewResult = {};
  let rounds = 0;
  for (let r = 1; r <= maxRounds; r++) {
    rounds = r;
    const diff = await diffSince(cwd, base);
    ctx.update({ diff });

    const review = await ctx.turn({
      agent: reviewer,
      role: 'reviewer',
      sessionKey: 'reviewer',
      phase: 'review',
      round: r,
      title: `${label(reviewer)} reviews & tests – round ${r}`,
      prompt: render('review', { coder: label(coder), cwd, round: r, prompt, summary, diff: formatDiff(diff), testHint }),
      parseVerdict: (t) => parseReview(t).verdict as Verdict | undefined,
    });
    lastReview = parseReview(review.text);

    if (lastReview.verdict === 'APPROVE') {
      approved = true;
      break;
    }
    if (r === maxRounds) break;

    summary = (
      await ctx.turn({
        agent: coder,
        role: 'coder',
        sessionKey: 'coder',
        phase: 'fix',
        round: r + 1,
        title: `${label(coder)} addresses review – round ${r}`,
        prompt: render('fix', { reviewer: label(reviewer), round: r, review: review.text }),
      })
    ).text;
  }

  const diff = await diffSince(cwd, base);
  const openIssues = (lastReview.issues ?? []).map((i) => `- **${i.severity ?? '?'}** ${i.file ? `\`${i.file}\` ` : ''}${i.description ?? ''}`).join('\n');
  const final = [
    approved
      ? `## ✅ Approved by ${label(reviewer)} after ${rounds} review round(s)`
      : `## ⚠️ Not approved after ${rounds} review round(s)`,
    `- Coder: **${label(coder)}** · Reviewer/tester: **${label(reviewer)}**`,
    `- Tests: **${lastReview.tests ?? 'unknown'}**`,
    `- Files changed: **${(diff.match(/^diff --git/gm) ?? []).length}** (not committed — review the diff below, then commit yourself)`,
    openIssues ? `\n### Remaining issues\n${openIssues}` : '',
    `\n### Coder's last summary\n${summary}`,
  ].join('\n');
  ctx.update({ diff, final });
}
