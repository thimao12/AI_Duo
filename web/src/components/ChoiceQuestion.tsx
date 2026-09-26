import { useState } from 'react';
import { ArrowRight, CircleAlert } from 'lucide-react';
import { api } from '../api.ts';
import { parseChoiceQuestion } from '../question.ts';
import { Spinner } from './ui.tsx';

export default function ChoiceQuestion({ runId, text, onContinue }: { runId: string; text: string; onContinue: () => void }) {
  const question = parseChoiceQuestion(text);
  const [selected, setSelected] = useState<number | 'other' | null>(null);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
    <section aria-label="Chọn câu trả lời" className="mt-5 rounded-2xl border border-line bg-surface/60 p-4">
      <p className="mb-3 text-[13.5px] font-semibold text-fg">{question.question}</p>
      <div role="radiogroup" aria-label={question.question} className="space-y-2">
        {question.options.map((option, index) => (
          <label key={index} className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-[13px] transition-colors ${selected === index ? 'border-focus bg-focus/5 text-fg' : 'border-line bg-bg text-muted hover:border-line-strong hover:text-fg'}`}>
            <input type="radio" name={`choice-${runId}`} checked={selected === index} onChange={() => setSelected(index)} disabled={busy} className="mt-0.5 accent-primary" />
            <span><span className="mr-2 font-mono text-faint">{index + 1}.</span>{option}</span>
          </label>
        ))}
        <label className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-[13px] transition-colors ${selected === 'other' ? 'border-focus bg-focus/5 text-fg' : 'border-line bg-bg text-muted hover:border-line-strong hover:text-fg'}`}>
          <input type="radio" name={`choice-${runId}`} checked={selected === 'other'} onChange={() => setSelected('other')} disabled={busy} className="mt-0.5 accent-primary" />
          <span className="flex-1">
            <span>Khác</span>
            {selected === 'other' && <textarea autoFocus value={custom} onChange={(event) => setCustom(event.target.value)} disabled={busy} rows={2} placeholder="Nhập câu trả lời của bạn…" className="mt-2 block w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-fg placeholder:text-faint focus:border-focus focus:outline-none" />}
          </span>
        </label>
      </div>
      {error && <p role="alert" className="mt-3 flex items-center gap-1.5 text-[12.5px] text-danger"><CircleAlert aria-hidden className="size-3.5" />{error}</p>}
      <button type="button" onClick={() => void submit()} disabled={!answer || busy} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-[13px] font-medium text-primary-fg hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? <Spinner className="size-3.5" /> : <ArrowRight aria-hidden className="size-3.5" />}
        Gửi câu trả lời
      </button>
    </section>
  );
}
