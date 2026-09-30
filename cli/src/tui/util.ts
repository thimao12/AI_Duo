import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentName } from '../../../server/src/agents/types.ts';
import { listModels } from '../../../server/src/models.ts';
import type { ModelCatalog } from '../../../server/src/types.ts';

/** A colour name, or undefined when NO_COLOR asks for plain text. Read at render time. */
export const paint = (name: string): string | undefined => (process.env.NO_COLOR ? undefined : name);

export const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A fresh id that satisfies the server's /^[a-z0-9-]{1,32}$/ and is not in `taken`. */
export function newId(prefix: string, taken: readonly string[]): string {
  for (let n = 1; n < 1000; n++) {
    const id = `${prefix}-${n}`;
    if (!taken.includes(id)) return id;
  }
  return `${prefix}-${Date.now().toString(36)}`;
}

export interface LoaderState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: (force?: boolean) => void;
}

/** Runs `load` on mount and on reload(); a rejection becomes `error` (the previous data stays); stale answers are dropped. */
export function useLoader<T>(load: (force: boolean) => Promise<T>): LoaderState<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const reload = useCallback((force = false) => {
    seq.current += 1;
    const id = seq.current;
    setState((s) => ({ ...s, loading: true }));
    loadRef.current(force).then(
      (data) => {
        if (id === seq.current) setState({ data, loading: false });
      },
      (err: unknown) => {
        if (id === seq.current) setState((s) => ({ data: s.data, error: errText(err), loading: false }));
      },
    );
  }, []);

  useEffect(() => {
    reload();
    return () => {
      seq.current += 1;
    };
  }, [reload]);

  return { data: state.data, error: state.error, loading: state.loading, reload };
}

/** Calls `tick` every `ms` while mounted. */
export function useInterval(tick: () => void, ms: number): void {
  const ref = useRef(tick);
  ref.current = tick;
  useEffect(() => {
    const timer = setInterval(() => ref.current(), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

/** First index to show so `index` stays inside a window of `height` rows over `total` rows. */
export function windowStart(total: number, index: number, height: number): number {
  if (total <= height) return 0;
  return Math.min(Math.max(0, index - Math.floor(height / 2)), total - height);
}

/** Model catalog of both agents; empty lists when it cannot be read. */
export function safeCatalog(): ModelCatalog {
  try {
    return listModels();
  } catch {
    return { claude: { models: [], default: {} }, codex: { models: [], default: {} } };
  }
}

/** Model ids of `agent` for suggestions. */
export const modelIds = (catalog: ModelCatalog, agent: AgentName): string[] => catalog[agent].models.map((m) => m.id);

/** Efforts the model accepts (all efforts of the agent's models when the model is not in the catalog). */
export function effortsFor(catalog: ModelCatalog, agent: AgentName, model: string): string[] {
  const info = catalog[agent].models.find((m) => m.id === model);
  if (info) return info.efforts;
  return [...new Set(catalog[agent].models.flatMap((m) => m.efforts))];
}

/** Options for an editable cycle field: empty (default) first, then `options`, then the current free-text value. */
export const withCurrent = (options: readonly string[], current: string): string[] => [...new Set(['', ...options, ...(current ? [current] : [])])];
