import { createInterface, type Interface } from 'node:readline';
import type { RunHandle } from '../../server/src/service.ts';
import type { PairDecision, PlanDecision, PlanDecisionAnswer, RunEvent } from '../../server/src/types.ts';
import type { Style } from './render.ts';

export interface DecisionPolicy {
  /** Answer every Plan approval with this instead of asking. */
  plan?: 'approve' | 'stop';
  /** Extra Code review rounds the run may take on its own (granted in blocks, see PairDecision.extraRounds). */
  pairExtraRounds?: number;
  /** Ask on the terminal when no flag decides; otherwise stop. */
  interactive: boolean;
}

export interface DecisionIO {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
  style: Style;
  /** Called before a prompt, so streamed output ends on its own line. */
  beforePrompt(): void;
  /** Ctrl+C typed while a prompt holds the terminal in raw mode. */
  onInterrupt(): void;
}

/**
 * Answers the run's decision points. Without a TTY every decision stops unless a flag says
 * otherwise: approving a plan starts Code, which edits files, so it is never a default.
 */
export class DecisionController {
  private handle?: RunHandle;
  private grantedRounds = 0;
  private stdinClosed = false;
  private prompt?: { rl: Interface; cancel: () => void };
  private queue = Promise.resolve();
  /** Set when the command could not do what its flags asked (the run itself may still end "done"). */
  problem?: string;

  constructor(
    private readonly policy: DecisionPolicy,
    private readonly io: DecisionIO,
  ) {}

  attach(handle: RunHandle) {
    this.handle = handle;
    // A decision may already be waiting if it was raised before the handle was returned.
    if (handle.run.planDecision) this.enqueue(() => this.plan(handle.run.planDecision!));
    if (handle.run.pairDecision) this.enqueue(() => this.pair(handle.run.pairDecision!));
  }

  onEvent(e: RunEvent) {
    if (e.type !== 'run.update') return;
    const { planDecision, pairDecision } = e.patch;
    // Answered elsewhere or cancelled: drop the open prompt.
    if (planDecision === null || pairDecision === null) this.prompt?.cancel();
    if (!this.handle) return; // attach() picks it up
    if (planDecision) this.enqueue(() => this.plan(planDecision));
    if (pairDecision) this.enqueue(() => this.pair(pairDecision));
  }

  close() {
    this.prompt?.cancel();
  }

  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue.then(task).catch((err) => this.say(this.io.style.red(`Decision failed: ${(err as Error).message}`)));
  }

  private say(text: string) {
    this.io.beforePrompt();
    this.io.output.write(`${text}\n`);
  }

  /** Answer the waiting plan; a refused answer (approval outside Git) is reported and returns false. */
  private async answerPlan(answer: PlanDecisionAnswer): Promise<boolean> {
    try {
      await this.handle!.answerPlanDecision(answer);
      return true;
    } catch (err) {
      this.say(this.io.style.red((err as Error).message));
      return false;
    }
  }

  private async plan(decision: PlanDecision) {
    const handle = this.handle!;
    if (!handle.run.planDecision) return;
    if (this.policy.plan || !this.policy.interactive) {
      await this.planByPolicy();
      return;
    }
    await this.planByAsking(decision);
  }

  private async planByPolicy() {
    const { style } = this.io;
    const action = this.policy.plan ?? 'stop';
    const source = this.policy.plan ? ' (--plan-decision)' : ' (no terminal; pass --plan-decision=approve to implement the plan)';
    this.say(style.cyan(`Plan decision: ${action}${source}`));
    if (!(await this.answerPlan({ action })) && action === 'approve') {
      // Code cannot start here: keep the plan and fail the command instead of leaving it waiting.
      this.problem = 'Plan approval was refused, so the plan was stopped without running Code.';
      await this.answerPlan({ action: 'stop' });
    }
  }

  /** stdin closed while a plan prompt was open: stop the plan unless it was answered meanwhile. */
  private async stopPlanOnClosedStdin() {
    if (!this.handle!.run.planDecision) return; // answered or cancelled meanwhile
    this.say(this.io.style.yellow('stdin closed; cannot collect decision'));
    await this.answerPlan({ action: 'stop' });
  }

  private async planByAsking(decision: PlanDecision) {
    const handle = this.handle!;
    const { style } = this.io;
    this.say(`\n${style.bold('── Kế hoạch ──')}\n${handle.run.final ?? ''}\n`);
    const reviewed = decision.reviewRounds ? `, ${decision.reviewRounds} review round(s)` : '';
    this.say(style.bold(`Plan ready (revision ${decision.revision}${reviewed}).`));
    if (decision.codeBlocked) this.say(style.yellow(`Approve is unavailable: ${decision.codeBlocked}`));
    for (;;) {
      const approve = decision.codeBlocked ? style.dim('[a]pprove (needs Git)') : `${style.bold('[a]pprove')} and implement`;
      const answer = await this.ask(`${approve} · ${style.bold('[r]efine')} with feedback · ${style.bold('[s]top')} › `);
      if (answer === undefined) {
        await this.stopPlanOnClosedStdin();
        return;
      }
      if (await this.handlePlanChoice(answer.trim().toLowerCase())) return;
      // Anything else (including a bare Enter) asks again: approving must be explicit.
    }
  }

  /** Apply one typed choice; returns true when the decision is settled. */
  private async handlePlanChoice(choice: string): Promise<boolean> {
    // A refused approval (not a Git repository) leaves the plan waiting: ask again.
    if (choice === 'a' || choice === 'approve') return this.answerPlan({ action: 'approve' });
    if (choice === 's' || choice === 'stop') {
      await this.answerPlan({ action: 'stop' });
      return true;
    }
    if (choice === 'r' || choice === 'refine') {
      const feedback = await this.ask('Feedback › ');
      if (feedback === undefined) {
        await this.stopPlanOnClosedStdin();
        return true;
      }
      return !!feedback.trim() && (await this.answerPlan({ action: 'refine', feedback: feedback.trim() }));
    }
    return false;
  }

  private async pair(decision: PairDecision) {
    if (!this.handle!.run.pairDecision) return;
    if (this.policy.pairExtraRounds !== undefined || !this.policy.interactive) {
      this.pairByPolicy(decision);
      return;
    }
    await this.pairByAsking(decision);
  }

  private pairByPolicy(decision: PairDecision) {
    const { style } = this.io;
    const budget = this.policy.pairExtraRounds ?? 0;
    const go = this.grantedRounds + decision.extraRounds <= budget;
    if (go) this.grantedRounds += decision.extraRounds;
    const outcome = go ? `continuing with ${decision.extraRounds} more round(s)` : 'stopping';
    const hint = this.policy.pairExtraRounds === undefined ? '; pass --pair-extra-rounds=N to allow more' : '';
    this.say(style.cyan(`Review limit reached: ${outcome} (extra-round budget ${this.grantedRounds}/${budget}${hint})`));
    this.handle!.answerPairDecision(go);
  }

  private async pairByAsking(decision: PairDecision) {
    const handle = this.handle!;
    const { style } = this.io;
    this.say(style.bold(`Not approved after round ${decision.round}.`));
    for (;;) {
      const answer = await this.ask(`${style.bold('[c]ontinue')} with ${decision.extraRounds} more rounds · ${style.bold('[s]top')} › `);
      if (answer === undefined) {
        if (!handle.run.pairDecision) return;
        this.say(style.yellow('stdin closed; cannot collect decision'));
        handle.answerPairDecision(false);
        return;
      }
      const choice = answer.trim().toLowerCase();
      if (choice === 'c' || choice === 'continue') {
        handle.answerPairDecision(true);
        return;
      }
      if (choice === 's' || choice === 'stop') {
        handle.answerPairDecision(false);
        return;
      }
    }
  }

  /** One line from the terminal; undefined when stdin closed or the prompt was cancelled. */
  private ask(question: string): Promise<string | undefined> {
    if (this.stdinClosed) return Promise.resolve(undefined);
    this.io.beforePrompt();
    return new Promise((resolve) => {
      const rl = createInterface({ input: this.io.input, output: this.io.output, terminal: !!this.io.input.isTTY });
      let settled = false;
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        this.prompt = undefined;
        rl.removeListener('close', onClose);
        rl.close();
        resolve(value);
      };
      const onClose = () => {
        this.stdinClosed = true;
        finish(undefined);
      };
      rl.once('close', onClose);
      rl.on('SIGINT', () => this.io.onInterrupt());
      this.prompt = { rl, cancel: () => finish(undefined) };
      rl.question(question, (answer) => finish(answer));
    });
  }
}
