import type { AgentName } from '../agents/types.ts';
import type { RunContext } from '../run.ts';
import type { Verdict } from '../types.ts';

const label = (agent: AgentName) => agent === 'claude' ? 'Claude' : 'Codex';

export function parsePlanVerdict(text: string): Verdict {
  const match = [...text.matchAll(/(?:PLAN_)?VERDICT:\s*\**\s*(APPROVE|CHANGES_REQUESTED|REVISE)\b/gi)].pop();
  return match?.[1].toUpperCase() === 'APPROVE' ? 'APPROVE' : 'CHANGES_REQUESTED';
}

/** One agent drafts a read-only implementation plan; another reviews it before user approval. */
export async function runPlan(ctx: RunContext): Promise<boolean> {
  const { cwd, coder: planner, reviewer } = ctx.run.config;
  const reviewerAgent = reviewer ?? planner;
  const task = ctx.prompt;
  let previousPlan = '';
  let feedback = '';
  let revision = 0;

  while (!ctx.cancelled) {
    if (feedback) ctx.followUp(feedback);
    const draft = await ctx.turn({
      agent: planner,
      role: 'thinker',
      phase: 'plan',
      round: revision + 1,
      title: revision ? `${label(planner)} revises the plan` : `${label(planner)} drafts the plan`,
      sessionKey: 'plan-writer',
      prompt: revision
        ? `Revise the implementation plan using the user's requested changes and the review feedback. Inspect the repository at ${cwd} as needed. Stay read-only: do not edit files or run commands that modify data.\n\nOriginal task:\n${task}\n\nPrevious plan:\n${previousPlan}\n\nUser's requested changes:\n${feedback}\n\nProduce the complete updated plan, including relevant files, ordered steps, edge cases, and verification. Do not implement anything.`
        : `You are a software architect working in read-only planning mode. Inspect the repository at ${cwd} as needed. Do not edit files or run commands that modify data. Create a concrete implementation plan for this task:\n\n${task}\n\nReturn relevant files, ordered implementation steps, edge cases, and how to verify the work. Do not implement the changes.`,
    });
    let plan = draft.text;
    let reviewText = '';
    let reviewRounds = 0;

    for (let round = 1; round <= 2; round++) {
      reviewRounds = round;
      const review = await ctx.turn({
        agent: reviewerAgent,
        role: 'thinker',
        phase: 'plan-review',
        round,
        title: `${label(reviewerAgent)} reviews the plan · round ${round}`,
        sessionKey: 'plan-review',
        prompt: `Review this proposed implementation plan for completeness, correctness, scope, risks, and whether the verification steps are useful. Inspect the repository read-only if needed. Do not edit files. If it is ready, write PLAN_VERDICT: APPROVE. Otherwise write PLAN_VERDICT: CHANGES_REQUESTED and list concrete corrections.\n\nOriginal task:\n${task}\n\nPlan to review:\n${plan}`,
        parseVerdict: (text) => parsePlanVerdict(text),
      });
      reviewText = review.text;
      if (review.verdict === 'APPROVE') break;
      if (round < 2) {
        const revised = await ctx.turn({
          agent: planner,
          role: 'thinker',
          phase: 'plan-revise',
          round,
          title: `${label(planner)} applies plan review`,
          sessionKey: 'plan-writer',
          prompt: `Revise the plan to address the review below. Inspect the repository read-only if needed. Do not implement anything. Return the complete updated plan with relevant files, ordered steps, edge cases, and verification.\n\nOriginal task:\n${task}\n\nCurrent plan:\n${plan}\n\nReview feedback:\n${reviewText}`,
        });
        plan = revised.text;
      }
    }

    const finalPlan = reviewText && parsePlanVerdict(reviewText) !== 'APPROVE'
      ? `${plan}\n\n### Reviewer notes after the final review\n${reviewText}`
      : plan;
    ctx.update({ final: finalPlan });
    const answer = await ctx.waitForPlanDecision({ type: 'plan-approval', reviewRounds, revision });
    if (answer.action === 'approve') return true;
    if (answer.action !== 'refine' || ctx.cancelled) return false;

    previousPlan = finalPlan;
    feedback = answer.feedback;
    revision++;
  }
  return false;
}
