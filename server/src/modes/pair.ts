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

export function parseReview(text: string): ReviewResult {
  const blocks = fencedBlocks(text);
  for (const b of blocks.reverse()) {
    try {
      const obj = JSON.parse(b);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.verdict !== 'string') continue;
      const verdict = obj.verdict.trim().toUpperCase();
      if (verdict !== 'APPROVE' && verdict !== 'CHANGES_REQUESTED') continue;
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
    } catch {}
  }
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
  const { cwd, maxRounds, coder, testCommand } = ctx.run.config;
  const prompt = ctx.prompt;
  const reviewer = ctx.run.config.reviewer ?? other(coder);

  if (!(await isGitRepo(cwd))) {
    throw new Error(`Pair mode needs a git repository so changes can be diffed and reverted. "${cwd}" is not one (run \`git init\` there first).`);
  }
  const base = await snapshotTree(cwd);
  ctx.note('Đã chụp trạng thái ban đầu', `Snapshot working tree (tree ${base.slice(0, 10)}). Diff cuối phiên chỉ gồm thay đổi của agent. Không có gì được commit.`);

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
  let reviewLimit = maxRounds + (ctx.run.pairRoundsGranted ?? 0);
  for (let r = 1; r <= reviewLimit; r++) {
    rounds = r;
    const diff = await diffSince(cwd, base);
    ctx.update({ diff });

    const reviewTreeBefore = await snapshotTree(cwd);
    let reviewTreeAfter = reviewTreeBefore;
    let reviewerChanges: { stat: string; files: string[] } | undefined;
    const review = await ctx.turn({
      agent: reviewer,
      role: 'reviewer',
      sessionKey: 'reviewer',
      phase: 'review',
      round: r,
      title: `${label(reviewer)} reviews & tests – round ${r}`,
      prompt: render('review', { coder: label(coder), cwd, round: r, prompt, summary, diff: formatDiff(diff), testHint }),
      parseVerdict: async (text): Promise<Verdict> => {
        reviewTreeAfter = await snapshotTree(cwd);
        if (reviewTreeBefore !== reviewTreeAfter) {
          reviewerChanges = await diffTreeSummary(cwd, reviewTreeBefore, reviewTreeAfter);
        }
        const verdict = parseReview(text).verdict;
        return verdict === 'APPROVE' && reviewerChanges ? 'CHANGES_REQUESTED' : verdict ?? 'CHANGES_REQUESTED';
      },
    });
    lastReview = parseReview(review.text);

    if (!lastReview.verdict) {
      ctx.note('Reviewer không trả verdict hợp lệ', '→ coi như CHANGES_REQUESTED', 'review', r);
    }
    if (reviewerChanges) {
      ctx.note(
        'Reviewer đã sửa tệp trong lượt đánh giá',
        `Lượt đánh giá ${r} đã thay đổi working tree nên verdict APPROVE bị từ chối.\n\nTheo lệnh git diff --stat ${reviewTreeBefore} ${reviewTreeAfter}:\n${reviewerChanges.stat || '(không có thống kê)'}\n\nCác tệp đã thay đổi:\n${reviewerChanges.files.map((file) => `- ${file}`).join('\n')}`,
        'review',
        r,
      );
    }

    if (lastReview.verdict !== 'APPROVE' && r >= reviewLimit) {
      ctx.note(
        'Chưa được approve sau 2 vòng review',
        `Test: ${lastReview.tests ?? 'không rõ'}. Bạn có muốn cấp thêm 2 vòng sửa và review hay dừng lại?`,
        'review',
        r,
      );
      const continueRun = await ctx.waitForPairDecision({ type: 'review-limit', round: r, extraRounds: 2 });
      if (!continueRun) {
        if (!ctx.cancelled) ctx.note('Đã dừng theo lựa chọn', `Dừng sau vòng ${r}; không thêm vòng sửa.`, 'review', r);
        break;
      }
      const granted = (ctx.run.pairRoundsGranted ?? 0) + 2;
      reviewLimit = maxRounds + granted;
      ctx.update({ pairRoundsGranted: granted });
      ctx.note('Tiếp tục Pair', `Đã thêm 2 vòng. Tổng giới hạn hiện tại: ${reviewLimit} vòng review.`, 'review', r);
    }

    if (lastReview.verdict === 'APPROVE' && !reviewerChanges) {
      approved = true;
      break;
    }
    if (r >= reviewLimit) break;

    summary = (
      await ctx.turn({
        agent: coder,
        role: 'coder',
        sessionKey: 'coder',
        phase: 'fix',
        round: r + 1,
        title: `${label(coder)} addresses review – round ${r}`,
        prompt: render('fix', {
          reviewer: label(reviewer),
          round: r,
          review: reviewerChanges
            ? `${review.text}\n\nThe reviewer changed these files during review. Treat this as CHANGES_REQUESTED:\n${reviewerChanges.files.map((file) => `- ${file}`).join('\n')}`
            : review.text,
        }),
      })
    ).text;
  }

  const diff = await diffSince(cwd, base);
  const openIssues = (lastReview.issues ?? []).map((i) => `- **${i.severity ?? '?'}** ${i.file ? `\`${i.file}\` ` : ''}${i.description ?? ''}`).join('\n');
  const final = [
    approved
      ? `## ${label(reviewer)} đã approve sau ${rounds} vòng review`
      : `## Chưa được approve sau ${rounds} vòng review`,
    `- Code: **${label(coder)}** · Review/test: **${label(reviewer)}**`,
    `- Test: **${lastReview.tests ?? 'không rõ'}**`,
    `- File thay đổi: **${(diff.match(/^diff --git/gm) ?? []).length}** (chưa commit, xem diff rồi tự commit)`,
    openIssues ? `\n### Vấn đề còn lại\n${openIssues}` : '',
    `\n### Tóm tắt cuối của người code\n${summary}`,
  ].join('\n');
  ctx.update({ diff, final });
}
