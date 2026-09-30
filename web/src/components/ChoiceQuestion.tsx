import { useState } from 'react';
import { ArrowRight, CircleAlert, CircleHelp, PencilLine } from 'lucide-react';
import { api } from '../api.ts';
import { parseChoiceQuestion } from '../question.ts';
import { Spinner, useInputFocus } from './ui.tsx';

/** One radio row; the native input stays for keyboard support but is visually hidden. */
const row = (active: boolean) =>
  `flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-[13.5px] leading-snug transition-colors has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus has-[input:disabled]:cursor-not-allowed ${
    active ? 'border-focus bg-focus text-bg' : 'border-line bg-bg text-fg hover:border-line-strong hover:bg-surface'
  }`;
const badge = (active: boolean) =>
  `grid size-6 shrink-0 place-items-center rounded-md text-[12px] font-semibold tabular-nums ${active ? 'bg-bg text-focus' : 'border border-line bg-surface text-muted'}`;

export default function ChoiceQuestion({ runId, text, onContinue }: { runId: string; text: string; onContinue: () => void }) {
  const question = parseChoiceQuestion(text);
  const [selected, setSelected] = useState<number | 'other' | null>(null);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const customInput = useInputFocus<HTMLTextAreaElement>();

  if (!question) return null;

  const questionText = question.question;
  const answer = selected === 'other' ? custom.trim() : selected === null ? '' : question.options[selected];
  async function submit() {
    if (!answer || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = selected === 'other' ? answer : `Mình chọn phương án ${selected! + 1} cho câu hỏi "${questionText}": ${answer}`;
      await api.continue(runId, response, []);
      onContinue();
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }

  return (
    <section aria-label="Chọn câu trả lời" className="mt-5 overflow-hidden rounded-2xl border border-line bg-surface/60">
      <p className="flex items-start gap-2 border-b border-line px-4 py-3 text-[13.5px] font-semibold text-fg">
        <CircleHelp aria-hidden className="mt-0.5 size-4 shrink-0 text-focus" />
        <span className="min-w-0">{question.question}</span>
      </p>
      <div className="p-3">
        <div role="radiogroup" aria-label={question.question} className="space-y-2">
          {question.options.map((option, index) => (
            <label key={index} className={row(selected === index)}>
              <input type="radio" name={`choice-${runId}`} checked={selected === index} onChange={() => setSelected(index)} disabled={busy} className="sr-only" />
              <span aria-hidden className={badge(selected === index)}>{index + 1}</span>
              <span className="min-w-0 pt-0.5 break-words">{option}</span>
            </label>
          ))}
          <label className={row(selected === 'other')}>
            <input type="radio" name={`choice-${runId}`} checked={selected === 'other'} onChange={() => setSelected('other')} disabled={busy} className="sr-only" />
            <span aria-hidden className={badge(selected === 'other')}><PencilLine className="size-3.5" /></span>
            <span className="min-w-0 pt-0.5">Trả lời khác…</span>
          </label>
        </div>
        {selected === 'other' && (
          <textarea
            ref={customInput}
            aria-label="Câu trả lời khác"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            disabled={busy}
            rows={2}
            placeholder="Nhập câu trả lời của bạn…"
            className="mt-2 block w-full resize-y rounded-xl border border-line bg-bg px-3 py-2 text-[13.5px] text-fg placeholder:text-faint focus:border-focus focus:outline-none disabled:opacity-60"
          />
        )}
        {error && <p role="alert" className="mt-3 flex items-center gap-1.5 text-[12.5px] text-danger"><CircleAlert aria-hidden className="size-3.5 shrink-0" />{error}</p>}
        <div className="mt-3 flex justify-end">
          <button type="button" onClick={() => void submit()} disabled={!answer || busy} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-[13px] font-medium text-primary-fg hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? <Spinner className="size-3.5" /> : <ArrowRight aria-hidden className="size-3.5" />}
            {busy ? 'Đang gửi…' : 'Gửi câu trả lời'}
          </button>
        </div>
      </div>
    </section>
  );
}
