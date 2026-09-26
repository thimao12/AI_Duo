import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'ai-duo:theme';

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** 'system' leaves data-theme unset so the CSS follows prefers-color-scheme. */
function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
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
    media.addEventListener('change', syncTitleBar);
    return () => media.removeEventListener('change', syncTitleBar);
  }, [pref]);
  const cycle = () => setPref((p) => (p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system'));
  return { pref, cycle };
}
