import { useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { errorText } from './theme.ts';
import type { RoutePreview } from './StatusLine.tsx';
import type { ChatService, Phase } from './useSession.ts';

/** Checks both agent CLIs once at start; returns the problems to show in a banner (empty when fine). */
export function usePreflight(service: ChatService, cwd: string, skip: boolean, enabled: boolean): string[] {
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    service.preflight(['claude', 'codex'], cwd, skip).then(
      (report) => {
        if (live) setProblems(report.problems);
      },
      (err: unknown) => {
        if (live) setProblems([errorText(err)]);
      },
    );
    return () => {
      live = false;
    };
  }, [service, cwd, skip, enabled]);
  return problems;
}

const PREVIEW_DELAY_MS = 500;

/** Rules-only routing preview (free, instant) for the typed prompt, shown in the status line. */
export function useRoutePreview(service: ChatService, draft: string, mode: 'code' | 'plan', enabled: boolean): RoutePreview | null {
  const [preview, setPreview] = useState<RoutePreview | null>(null);
  useEffect(() => {
    const text = draft.trim();
    if (!enabled || !text || text.startsWith('/')) {
      setPreview(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      service.previewRoute(text, mode).then(
        (r) => {
          if (live) setPreview({ coder: r.coder, reviewer: r.reviewer });
        },
        () => {
          if (live) setPreview(null);
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [service, draft, mode, enabled]);
  return preview;
}

const EXIT_WINDOW_MS = 2500;

interface InterruptOptions {
  phase: Phase;
  cancel(): void;
  exit(): void;
  notice(text: string): void;
}

/**
 * Ctrl+C: while a run is going the first press stops it and the second quits; when idle the first
 * press only arms quitting (a second press within a few seconds quits).
 */
export function useInterrupt({ phase, cancel, exit, notice }: Readonly<InterruptOptions>) {
  const stopping = useRef(false);
  const armedAt = useRef(0);
  useEffect(() => {
    if (phase === 'idle') stopping.current = false;
  }, [phase]);

  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;
    if (phase === 'idle') {
      if (Date.now() - armedAt.current < EXIT_WINDOW_MS) exit();
      else notice('Press Ctrl+C again to exit (Ctrl+D also exits from an empty prompt).');
      armedAt.current = Date.now();
    } else if (stopping.current) {
      exit();
    } else {
      stopping.current = true;
      cancel();
      notice('Stopping the run… press Ctrl+C again to quit at once.');
    }
  });
}
