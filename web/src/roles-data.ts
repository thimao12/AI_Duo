import { useCallback, useEffect, useState } from 'react';
import { api, type PipelineDef, type RoleDef } from './api.ts';

const CHANGED = 'ai-duo:settings-changed';

/** Tell every open composer/modal that roles or pipelines were saved. */
export function notifySettingsChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
}

/** Roles and pipelines from the server; reloads whenever a modal saves. */
export function useSettingsData(): { roles: RoleDef[]; pipelines: PipelineDef[] } {
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [pipelines, setPipelines] = useState<PipelineDef[]>([]);

  const load = useCallback(() => {
    api.roles().then((r) => setRoles(r.roles), () => {});
    api.pipelines().then((p) => setPipelines(p.pipelines), () => {});
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(CHANGED, load);
    return () => window.removeEventListener(CHANGED, load);
  }, [load]);

  return { roles, pipelines };
}

/** A fresh id that satisfies the server's /^[a-z0-9-]{1,32}$/ and is not in `taken`. */
export function newId(prefix: string, taken: readonly string[]): string {
  for (let n = 1; n < 1000; n++) {
    const id = `${prefix}-${n}`;
    if (!taken.includes(id)) return id;
  }
  return `${prefix}-${Date.now().toString(36)}`;
}
