import { useEffect, useState } from 'react';
import type { Message, Part } from '../api.ts';
import { AGENT_LABEL, AGENT_STYLE, Markdown, Spinner, VerdictBadge } from './ui.tsx';

function elapsed(m: Message, now: number) {
  const s = Math.round(((m.endedAt ?? now) - m.startedAt) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Strip the machine-readable trailer the prompts ask for; it's shown as a badge instead. */
function cleanText(text: string) {
  return text.replace(/\n*`?VERDICT:\s*\**\s*(AGREE|REVISE)\**`?\s*$/i, '').trimEnd();
}

function ToolLine({ part, result }: { part: Part; result?: Part }) {
  const [first, ...rest] = part.content.split('\n');
  return (
    <details className="group rounded border border-zinc-800 bg-zinc-900/60 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1 font-mono text-zinc-400 hover:text-zinc-200">
        <span className="text-zinc-600 transition group-open:rotate-90">▸</span>
        <span className="truncate">{first}</span>
      </summary>
      {(rest.length > 0 || result) && (
        <pre className="max-h-72 overflow-auto border-t border-zinc-800 px-2 py-1.5 font-mono text-[11.5px] whitespace-pre-wrap text-zinc-400">
          {rest.join('\n')}
          {rest.length > 0 && result ? '\n' : ''}
          {result?.content}
        </pre>
      )}
    </details>
  );
}

export default function MessageCard({ message: m }: { message: Message }) {
  const style = AGENT_STYLE[m.agent];
  const running = m.status === 'running';
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Pair each tool call with the result that follows it.
  const items: { part: Part; result?: Part }[] = [];
  for (const p of m.parts) {
    const prev = items[items.length - 1];
    if (p.kind === 'tool_result' && prev?.part.kind === 'tool' && !prev.result) prev.result = p;
    else items.push({ part: p });
  }

  if (m.agent === 'system') {
    return (
      <div className="flex items-start gap-2 px-1 text-xs text-zinc-500">
        <span className="mt-1 size-1.5 shrink-0 rounded-full bg-zinc-600" />
        <span>
          <span className="font-medium text-zinc-400">{m.title}.</span> {m.parts.map((p) => p.content).join(' ')}
        </span>
      </div>
    );
  }

  return (
    <article className={`min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/40`}>
      <header className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
        <span className={`size-2 rounded-full ${style.dot}`} />
        <span className={`text-sm font-semibold ${style.text}`}>{AGENT_LABEL[m.agent]}</span>
        <span className="truncate text-sm text-zinc-400">{m.title.replace(/^(Claude|Codex)\s*/, '')}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-zinc-500">
          {m.verdict && <VerdictBadge verdict={m.verdict} />}
          {running && <Spinner />}
          {m.status === 'error' && <span className="text-red-400">failed</span>}
          <span className="tabular-nums">{elapsed(m, now)}</span>
        </span>
      </header>
      <div className="space-y-2 px-3 py-2.5">
        {items.length === 0 && running && <p className="text-sm text-zinc-500 italic">thinking…</p>}
        {items.map(({ part, result }, i) =>
          part.kind === 'text' ? (
            <Markdown key={i}>{cleanText(part.content)}</Markdown>
          ) : part.kind === 'tool' ? (
            <ToolLine key={i} part={part} result={result} />
          ) : part.kind === 'error' ? (
            <p key={i} className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-red-300">
              {part.content}
            </p>
          ) : (
            <pre key={i} className="overflow-x-auto font-mono text-[11px] whitespace-pre-wrap text-zinc-600">
              {part.content}
            </pre>
          ),
        )}
      </div>
    </article>
  );
}
