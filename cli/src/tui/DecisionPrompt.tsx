import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import type { RunHandle } from '../../../server/src/service.ts';
import type { PairDecision, PlanDecision, PlanDecisionAnswer } from '../../../server/src/types.ts';
import { Composer } from './Composer.tsx';
import { errorText, tone } from './theme.ts';

interface Choice {
  key: string;
  label: string;
  hint?: string;
}

function ChoiceList({ choices, selected }: Readonly<{ choices: readonly Choice[]; selected: number }>) {
  return (
    <Box flexDirection="column">
      {choices.map((choice, i) => (
        <Text key={choice.key} color={i === selected ? tone('cyan') : undefined} bold={i === selected}>
          {`${i === selected ? '›' : ' '} [${choice.key}] ${choice.label}`}
          {choice.hint ? <Text dimColor>{`  ${choice.hint}`}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

/** Up/Down move, Enter picks, a letter picks directly. Returns the picked key when a choice is made. */
function useChoiceKeys(choices: readonly Choice[], active: boolean, onPick: (key: string) => void) {
  const [selected, setSelected] = useState(0);
  useInput(
    (input, key) => {
      if (key.upArrow) setSelected((selected + choices.length - 1) % choices.length);
      else if (key.downArrow || key.tab) setSelected((selected + 1) % choices.length);
      else if (key.return) onPick(choices[selected].key);
      else if (choices.some((c) => c.key === input.toLowerCase())) onPick(input.toLowerCase());
    },
    { isActive: active },
  );
  return selected;
}

const PLAN_CHOICES: readonly Choice[] = [
  { key: 'a', label: 'Approve and run Code', hint: 'edits files in this repository' },
  { key: 'r', label: 'Refine the plan with feedback' },
  { key: 's', label: 'Stop here', hint: 'keep the plan, change nothing' },
];

function planHeadline(decision: PlanDecision): string {
  const reviewed = decision.reviewRounds ? `, ${decision.reviewRounds} review round(s)` : '';
  return `Plan ready (revision ${decision.revision}${reviewed}). What next?`;
}

/** Plan approval: approve (starts Code), refine with feedback, or stop. */
export function PlanDecisionPrompt({ handle, decision }: Readonly<{ handle: RunHandle; decision: PlanDecision }>) {
  const [refining, setRefining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  /** Send an answer; a refusal (approval outside Git) is shown and the plan keeps waiting. */
  const answer = async (payload: PlanDecisionAnswer): Promise<string | null> => {
    if (busy.current) return null;
    busy.current = true;
    try {
      await handle.answerPlanDecision(payload);
      return null;
    } catch (err) {
      const message = errorText(err);
      setError(message);
      return message;
    } finally {
      busy.current = false;
    }
  };

  const pick = (key: string) => {
    if (key === 'a' && decision.codeBlocked) setError(`Approve is unavailable: ${decision.codeBlocked}`);
    else if (key === 'a') void answer({ action: 'approve' });
    else if (key === 'r') setRefining(true);
    else void answer({ action: 'stop' });
  };
  const selected = useChoiceKeys(PLAN_CHOICES, !refining, pick);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tone('yellow')} paddingX={1}>
      <Text bold>{planHeadline(decision)}</Text>
      {decision.codeBlocked ? <Text color={tone('yellow')}>{`Approve is unavailable: ${decision.codeBlocked}`}</Text> : null}
      {refining ? (
        <Box flexDirection="column">
          <Text dimColor>What should change in the plan? Enter sends · Esc goes back</Text>
          <Composer
            plain
            placeholder="Feedback for the plan"
            onSubmit={(text) => answer({ action: 'refine', feedback: text })}
            onEscape={() => setRefining(false)}
          />
        </Box>
      ) : (
        <ChoiceList choices={PLAN_CHOICES} selected={selected} />
      )}
      {error && !decision.codeBlocked ? <Text color={tone('red')}>{error}</Text> : null}
    </Box>
  );
}

const PAIR_CHOICES: readonly Choice[] = [
  { key: 'y', label: 'Yes, continue' },
  { key: 'n', label: 'No, stop' },
];

/** The review limit was reached: allow more rounds or stop. */
export function PairDecisionPrompt({ handle, decision }: Readonly<{ handle: RunHandle; decision: PairDecision }>) {
  const selected = useChoiceKeys(PAIR_CHOICES, true, (key) => {
    handle.answerPairDecision(key === 'y');
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tone('yellow')} paddingX={1}>
      <Text bold>{`Not approved after round ${decision.round}. Continue for ${decision.extraRounds} more rounds?`}</Text>
      <ChoiceList choices={PAIR_CHOICES} selected={selected} />
    </Box>
  );
}
