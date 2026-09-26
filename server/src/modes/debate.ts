import { other, type AgentName } from '../agents/index.ts';
import { render } from '../prompts/index.ts';
import type { RunContext } from '../run.ts';
import type { Verdict } from '../types.ts';

const label = (a: AgentName) => (a === 'claude' ? 'Claude' : 'Codex');

export function parseAgreeVerdict(text: string): Verdict | undefined {
  const m = [...text.matchAll(/VERDICT:\s*\**\s*(AGREE|REVISE)/gi)].pop();
  return m ? (m[1].toUpperCase() as Verdict) : undefined;
}

/**
 * 1. both propose in parallel
 * 2. rounds of cross-critique (each continues its own session) until both AGREE or maxRounds
 * 3. judge writes the final solution in a fresh session from the transcript
 */
export async function runDebate(ctx: RunContext) {
  const { cwd, maxRounds, judge } = ctx.run.config;
  const prompt = ctx.prompt;
  const both: AgentName[] = ['claude', 'codex'];
  const transcript: string[] = [];

  const proposals = await Promise.all(
    both.map((a) =>
      ctx.turn({
        agent: a,
        role: 'thinker',
        sessionKey: 'debate',
        phase: 'propose',
        round: 0,
        title: `${label(a)} – initial proposal`,
        prompt: render('propose', { me: label(a), peer: label(other(a)), cwd, prompt }),
      }),
    ),
  );
  let latest: Record<AgentName, string> = { claude: proposals[0].text, codex: proposals[1].text };
  transcript.push(`### Round 0 – Claude's proposal\n${latest.claude}`, `### Round 0 – Codex's proposal\n${latest.codex}`);

  let rounds = 0;
  let consensus = false;
  for (let r = 1; r <= maxRounds; r++) {
    rounds = r;
    const results = await Promise.all(
      both.map((a) =>
        ctx.turn({
          agent: a,
          role: 'thinker',
          sessionKey: 'debate',
          phase: 'critique',
          round: r,
          title: `${label(a)} reviews ${label(other(a))} – round ${r}`,
          prompt: render('critique', { round: r, peer: label(other(a)), peerText: latest[other(a)] }),
          parseVerdict: parseAgreeVerdict,
        }),
      ),
    );
    latest = { claude: results[0].text, codex: results[1].text };
    transcript.push(`### Round ${r} – Claude's review & revision\n${latest.claude}`, `### Round ${r} – Codex's review & revision\n${latest.codex}`);

    if (results.every((x) => x.verdict === 'AGREE')) {
      consensus = true;
      ctx.note('Đã đồng thuận', `Cả hai agent đồng ý sau vòng ${r}.`, 'critique', r);
      break;
    }
  }
  if (!consensus) ctx.note('Chưa đồng thuận hoàn toàn', `Dừng sau ${rounds} vòng; người chốt sẽ xử lý các điểm còn khác nhau.`, 'critique', rounds);

  const final = await ctx.turn({
    agent: judge,
    role: 'thinker',
    sessionKey: 'synthesis',
    modelRole: 'judge',
    phase: 'synthesize',
    round: rounds + 1,
    title: `Final solution (judge: ${label(judge)})`,
    prompt: render('synthesize', {
      rounds,
      consensus: consensus ? 'They reached consensus.' : 'They did not fully converge.',
      cwd,
      prompt,
      transcript: transcript.join('\n\n'),
    }),
  });
  ctx.update({ final: final.text });
}
