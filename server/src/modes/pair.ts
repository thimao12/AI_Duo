import { other, type AgentName } from '../agents/index.ts';
import { diffSince, diffTreeSummary, isGitRepo, snapshotTree } from '../git.ts';
import { render } from '../prompts/index.ts';
import type { RunContext } from '../run.ts';
import type { Verdict } from '../types.ts';
import { fencedBlocks } from '../../../shared/text.ts';

const label = (a: AgentName) => (a === 'claude' ? 'Claude' : 'Codex');
const MAX_DIFF_CHARS = 60_000;

export interface ReviewResult {
  verdict?: 'APPROVE' | 'CHANGES_REQUESTED';
  tests?: 'pass' | 'fail' | 'none';
  issues?: { severity?: string; file?: string; description?: string }[];
}

function parseReviewBlock(block: string): ReviewResult | undefined {
  try {
    const obj = JSON.parse(block);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.verdict !== 'string') return undefined;
    const verdict = obj.verdict.trim().toUpperCase();
    if (verdict !== 'APPROVE' && verdict !== 'CHANGES_REQUESTED') return undefined;
    const tests = typeof obj.tests === 'string' && /^(pass|fail|none)$/i.test(obj.tests.trim())
      ? obj.tests.trim().toLowerCase() as ReviewResult['tests']
      : undefined;

    const issues = Array.isArray(obj.issues)
      ? obj.issues
          .filter((issue: unknown): issue is Record<string, unknown> => !!issue && typeof issue === 'object' && !Array.isArray(issue))
          .map((issue: Record<string, unknown>) => ({
            ...(typeof issue.severity === 'string' ? { severity: issue.severity } : {}),
            ...(typeof issue.file === 'string' ? { file: issue.file } : {}),
            ...(typeof issue.description === 'string' ? { description: issue.description } : {}),
          }))
      : [];
    return {
      // A reviewer cannot approve code while also reporting a failed test suite.
      verdict: tests === 'fail' ? 'CHANGES_REQUESTED' : verdict,
      ...(tests && { tests }),
      issues,
    };
  } catch {
    return undefined;
  }
}

export function parseReview(text: string): ReviewResult {
  for (const b of fencedBlocks(text).toReversed()) {
    const review = parseReviewBlock(b);
    if (review) return review;
  }
  return {};
}

const fileList = (files: string[]) => files.map((file) => '- ' + file).join('\n');

function formatIssue(i: NonNullable<ReviewResult['issues']>[number]) {
  const file = i.file ? '`' + i.file + '` ' : '';
  return `- **${i.severity ?? '?'}** ${file}${i.description ?? ''}`;
}

type ReviewerChanges = { stat: string; files: string[] };

function resolveVerdict(text: string, reviewerChanges: ReviewerChanges | undefined): Verdict {
  const verdict = parseReview(text).verdict ?? 'CHANGES_REQUESTED';
  return verdict === 'APPROVE' && reviewerChanges ? 'CHANGES_REQUESTED' : verdict;
}

function noteReviewerChanges(ctx: RunContext, round: number, before: string, after: string, changes: ReviewerChanges) {
  ctx.note(
    'Reviewer đã sửa tệp trong lượt đánh giá',
    `Lượt đánh giá ${round} đã thay đổi working tree nên verdict APPROVE bị từ chối.\n\nTheo lệnh git diff --stat ${before} ${after}:\n${changes.stat || '(không có thống kê)'}\n\nCác tệp đã thay đổi:\n${fileList(changes.files)}`,
    'review',
    round,
  );
}

function fixFeedback(reviewText: string, changes: ReviewerChanges | undefined) {
  if (!changes) return reviewText;
  return `${reviewText}\n\nThe reviewer changed these files during review. Treat this as CHANGES_REQUESTED:\n${fileList(changes.files)}`;
}

/** Asks whether to grant two more rounds; returns the new total granted, or undefined to stop. */
async function askForExtraRounds(ctx: RunContext, lastReview: ReviewResult, round: number): Promise<number | undefined> {
  ctx.note(
    'Chưa được approve sau 2 vòng review',
    `Test: ${lastReview.tests ?? 'không rõ'}. Bạn có muốn cấp thêm 2 vòng sửa và review hay dừng lại?`,
    'review',
    round,
  );
  const continueRun = await ctx.waitForPairDecision({ type: 'review-limit', round, extraRounds: 2 });
  if (!continueRun) {
    if (!ctx.cancelled) ctx.note('Đã dừng theo lựa chọn', `Dừng sau vòng ${round}; không thêm vòng sửa.`, 'review', round);
    return undefined;
  }
  const granted = (ctx.run.pairRoundsGranted ?? 0) + 2;
  ctx.update({ pairRoundsGranted: granted });
  return granted;
}

function buildTestHint(testCommand: string | undefined) {
  return testCommand
    ? `Run \`${testCommand}\` to verify.`
    : 'Detect and run the project\'s relevant test / type-check / build commands (e.g. from package.json, Makefile, pyproject). If there are none, do a focused manual check.';
}

function formatDiff(diff: string) {
  if (!diff.trim()) return '_(no changes detected)_';
  const cut = diff.length > MAX_DIFF_CHARS;
  return '```diff\n' + (cut ? diff.slice(0, MAX_DIFF_CHARS) : diff) + '\n```' + (cut ? '\n(diff truncated – inspect the files directly for the rest)' : '');
}

async function reviewTurn(
  ctx: RunContext,
  o: { reviewer: Parameters<typeof label>[0]; coder: Parameters<typeof label>[0]; r: number; diff: string; summary: string; testHint: string },
) {
  const { reviewer, coder, r, diff, summary, testHint } = o;
  const { cwd } = ctx.run.config;
  const reviewTreeBefore = await snapshotTree(cwd);
  let reviewTreeAfter = reviewTreeBefore;
  let reviewerChanges: ReviewerChanges | undefined;
  const review = await ctx.turn({
    agent: reviewer,
    role: 'reviewer',
    sessionKey: 'reviewer',
    phase: 'review',
    round: r,
    title: `${label(reviewer)} reviews & tests – round ${r}`,
    prompt: render('review', { coder: label(coder), cwd, round: r, prompt: ctx.prompt, summary, diff: formatDiff(diff), testHint }),
    parseVerdict: async (text): Promise<Verdict> => {
      reviewTreeAfter = await snapshotTree(cwd);
      if (reviewTreeBefore !== reviewTreeAfter) {
        reviewerChanges = await diffTreeSummary(cwd, reviewTreeBefore, reviewTreeAfter);
      }
      return resolveVerdict(text, reviewerChanges);
    },
  });
  return { review, reviewTreeBefore, reviewTreeAfter, reviewerChanges };
}

function noteReview(
  ctx: RunContext,
  r: number,
  lastReview: ReviewResult,
  t: { reviewTreeBefore: string; reviewTreeAfter: string; reviewerChanges: ReviewerChanges | undefined },
) {
  if (!lastReview.verdict) {
    ctx.note('Reviewer không trả verdict hợp lệ', '→ coi như CHANGES_REQUESTED', 'review', r);
  }
  if (t.reviewerChanges) noteReviewerChanges(ctx, r, t.reviewTreeBefore, t.reviewTreeAfter, t.reviewerChanges);
}

async function nextStep(
  ctx: RunContext,
  o: { lastReview: ReviewResult; reviewerChanges: ReviewerChanges | undefined; r: number; reviewLimit: number; maxRounds: number },
): Promise<{ action: 'approved' | 'stop' | 'continue'; reviewLimit: number }> {
  const { lastReview, reviewerChanges, r, maxRounds } = o;
  let { reviewLimit } = o;
  if (lastReview.verdict !== 'APPROVE' && r >= reviewLimit) {
    const granted = await askForExtraRounds(ctx, lastReview, r);
    if (granted === undefined) return { action: 'stop', reviewLimit };
    reviewLimit = maxRounds + granted;
    ctx.note('Tiếp tục Pair', `Đã thêm 2 vòng. Tổng giới hạn hiện tại: ${reviewLimit} vòng review.`, 'review', r);
  }
  if (lastReview.verdict === 'APPROVE' && !reviewerChanges) return { action: 'approved', reviewLimit };
  return { action: r >= reviewLimit ? 'stop' : 'continue', reviewLimit };
}

/**
 * coder implements → reviewer reviews diff + runs tests → coder fixes → … until APPROVE or maxRounds.
 * Nothing is committed; the final diff is shown to the user.
 */
export async function runPair(ctx: RunContext) {
  const { cwd, maxRounds, coder, testCommand } = ctx.run.config;
  const prompt = ctx.prompt;
  const reviewer = ctx.run.config.reviewer ?? other(coder);

  if (!(await isGitRepo(cwd))) {
    throw new Error(`Pair mode needs a git repository so changes can be diffed and reverted. "${cwd}" is not one (run \`git init\` there first).`);
  }
  const base = await snapshotTree(cwd);
  ctx.note('Đã chụp trạng thái ban đầu', `Snapshot working tree (tree ${base.slice(0, 10)}). Diff cuối phiên chỉ gồm thay đổi của agent. Không có gì được commit.`);

  const testHint = buildTestHint(testCommand);

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
  let reviewLimit = maxRounds + (ctx.run.pairRoundsGranted ?? 0);
  for (let r = 1; r <= reviewLimit; r++) {
    rounds = r;
    const diff = await diffSince(cwd, base);
    ctx.update({ diff });

    const { review, reviewTreeBefore, reviewTreeAfter, reviewerChanges } = await reviewTurn(ctx, { reviewer, coder, r, diff, summary, testHint });
    lastReview = parseReview(review.text);

    noteReview(ctx, r, lastReview, { reviewTreeBefore, reviewTreeAfter, reviewerChanges });

    const next = await nextStep(ctx, { lastReview, reviewerChanges, r, reviewLimit, maxRounds });
    reviewLimit = next.reviewLimit;
    if (next.action === 'approved') approved = true;
    if (next.action !== 'continue') break;

    summary = (
      await ctx.turn({
        agent: coder,
        role: 'coder',
        sessionKey: 'coder',
        phase: 'fix',
        round: r + 1,
        title: `${label(coder)} addresses review – round ${r}`,
        prompt: render('fix', { reviewer: label(reviewer), round: r, review: fixFeedback(review.text, reviewerChanges) }),
      })
    ).text;
  }

  const diff = await diffSince(cwd, base);
  const final = buildFinalReport({ approved, rounds, coder, reviewer, lastReview, diff, summary });
  ctx.update({ diff, final });
}

function buildFinalReport(o: {
  approved: boolean;
  rounds: number;
  coder: Parameters<typeof label>[0];
  reviewer: Parameters<typeof label>[0];
  lastReview: ReviewResult;
  diff: string;
  summary: string;
}) {
  const { approved, rounds, coder, reviewer, lastReview, diff, summary } = o;
  const openIssues = (lastReview.issues ?? []).map(formatIssue).join('\n');
  return [
    approved
      ? `## ${label(reviewer)} đã approve sau ${rounds} vòng review`
      : `## Chưa được approve sau ${rounds} vòng review`,
    `- Code: **${label(coder)}** · Review/test: **${label(reviewer)}**`,
    `- Test: **${lastReview.tests ?? 'không rõ'}**`,
    `- File thay đổi: **${(diff.match(/^diff --git/gm) ?? []).length}** (chưa commit, xem diff rồi tự commit)`,
    openIssues ? `\n### Vấn đề còn lại\n${openIssues}` : '',
    `\n### Tóm tắt cuối của người code\n${summary}`,
  ].join('\n');
}
