import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'ai-duo:theme';
const NEXT_PREF: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolvedTheme(pref: ThemePref, systemDark: boolean): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return systemDark ? 'dark' : 'light';
}

/** Resolve system preference explicitly so tokens and Tailwind variants use the same selector. */
function apply(pref: ThemePref) {
  document.documentElement.dataset.theme = resolvedTheme(pref, matchMedia('(prefers-color-scheme: dark)').matches);
}

const desktop = (window as { aiDuo?: { setTitleBarColors?: (color: string, symbolColor: string) => void } }).aiDuo;

/** The desktop window draws its own min/max/close buttons; paint them with the resolved tokens. */
function syncTitleBar() {
  const css = getComputedStyle(document.documentElement);
  desktop?.setTitleBarColors?.(css.getPropertyValue('--bg').trim(), css.getPropertyValue('--muted').trim());
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(read);
  useEffect(() => {
    apply(pref);
    syncTitleBar();
    try {
      if (pref === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch {}
    if (pref !== 'system') return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => { apply(pref); syncTitleBar(); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [pref]);
  const cycle = () => setPref((p) => NEXT_PREF[p]);
  return { pref, setPref, cycle };
}
