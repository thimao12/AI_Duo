import { useState } from 'react';
import type { AgentName, ModelCatalog, ModelInfo } from '../api.ts';
import { AgentDot, AGENT_LABEL, MenuItem, MenuLabel, Popover, useInputFocus } from './ui.tsx';

const EFFORT_LABEL: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
export const effortLabel = (e: string) => EFFORT_LABEL[e] ?? e;

// The everyday three come first; heavier levels follow in the model's own order.
const ORDER = ['low', 'medium', 'high'];
const sortEfforts = (efforts: string[]) => [...efforts].sort((a, b) => (ORDER.indexOf(a) + 1 || 9) - (ORDER.indexOf(b) + 1 || 9));

interface ModelPickerProps {
  agent: AgentName;
  catalog: ModelCatalog | null;
  model: string;
  effort: string;
  /** Auto mode: an empty choice means "the router decides". */
  auto: boolean;
  side: 'top' | 'bottom';
  onChange: (next: { model: string; effort: string }) => void;
}

export default function ModelPicker({ agent, catalog, model, effort, auto, side, onChange }: ModelPickerProps) {
  const [typing, setTyping] = useState(false);
  const modelInput = useInputFocus<HTMLInputElement>();
  const info = catalog?.[agent];
  const models = info?.models ?? [];
  const selected: ModelInfo | undefined = models.find((m) => m.id === model);
  const fallback = info?.default ?? {};
  const fallbackModel = models.find((m) => m.id === fallback.model);

  // Levels on offer: the chosen model's, else the CLI default model's, else everything known.
  const levels = sortEfforts(
    selected?.efforts ?? (model ? [] : fallbackModel?.efforts ?? [...new Set(models.flatMap((m) => m.efforts))]),
  );
  const unknownModel = !!model && !selected;

  const pickModel = (id: string) => {
    const next = models.find((m) => m.id === id);
    // Drop an effort the new model does not accept.
    onChange({ model: id, effort: next && effort && !next.efforts.includes(effort) ? '' : effort });
  };

  const emptyLabel = auto ? 'Tự chọn' : 'Mặc định';
  // With nothing picked, name the agent: the dot's colour alone must not carry identity.
  const label = `${model ? (selected?.name ?? model) : `${AGENT_LABEL[agent]} ${emptyLabel.toLowerCase()}`}${effort ? ` · ${effortLabel(effort)}` : ''}`;

  return (
    <Popover
      side={side}
      width="w-[19rem]"
      title={`Model và mức suy luận của ${AGENT_LABEL[agent]}`}
      label={
        <>
          <AgentDot agent={agent} />
          <span className="truncate">{label}</span>
        </>
      }
    >
      {(close) => (
        <div>
          <MenuLabel>Model {AGENT_LABEL[agent]}</MenuLabel>
          <MenuItem
            selected={!model}
            label={auto ? 'Router tự chọn' : 'Mặc định của CLI'}
            hint={
              auto
                ? 'Chọn model theo độ khó của task.'
                : fallback.model
                  ? `${fallbackModel?.name ?? fallback.model}${fallback.effort ? ` · ${effortLabel(fallback.effort)}` : ''} (config.toml)`
                  : `Theo cấu hình của ${AGENT_LABEL[agent]} CLI.`
            }
            onSelect={() => onChange({ model: '', effort })}
          />
          {models.map((m) => (
            <MenuItem key={m.id} selected={model === m.id} label={m.name} hint={m.description} onSelect={() => pickModel(m.id)} />
          ))}
          {unknownModel && <MenuItem selected label={model} hint="Model nhập tay" onSelect={() => {}} />}
          {typing ? (
            <div className="px-1.5 py-1">
              <input
                ref={modelInput}
                defaultValue={unknownModel ? model : ''}
                placeholder="Tên model, ví dụ gpt-6-sol"
                className="w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] text-fg placeholder:font-sans placeholder:text-faint focus:border-focus focus:outline-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    pickModel(e.currentTarget.value.trim());
                    setTyping(false);
                  }
                }}
              />
            </div>
          ) : (
            <MenuItem label="Model khác…" onSelect={() => setTyping(true)} />
          )}

          <div className="my-1 border-t border-line" />
          <MenuLabel>Mức suy luận</MenuLabel>
          {levels.length === 0 ? (
            <p className="px-2.5 pb-2 text-[12.5px] leading-snug text-faint">
              {selected ? `${selected.name} không có tùy chọn mức suy luận.` : 'Model này không có danh sách mức suy luận.'}
            </p>
          ) : (
            <div role="radiogroup" aria-label="Mức suy luận" className="flex flex-wrap gap-1 px-2 pb-2">
              {['', ...levels].map((e) => {
                const on = effort === e;
                return (
                  <button
                    key={e || 'default'}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onChange({ model, effort: e })}
                    title={e ? undefined : auto ? 'Router tự chọn mức' : 'Mức mặc định của model'}
                    className={`h-7 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors ${
                      on ? 'border-fg bg-fg text-bg' : 'border-line text-muted hover:border-line-strong hover:text-fg'
                    }`}
                  >
                    {e ? effortLabel(e) : emptyLabel}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex justify-end px-2 pb-1.5">
            <button type="button" onClick={close} className="h-7 rounded-lg px-2.5 text-[12.5px] font-medium text-muted hover:bg-surface hover:text-fg">
              Xong
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}
