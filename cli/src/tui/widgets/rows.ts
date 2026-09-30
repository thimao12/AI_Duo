import { createContext, useContext } from 'react';

/** Rows a panel may use in the full-screen chat; undefined in inline mode (no limit besides the widgets' own). */
export const PanelRowsContext = createContext<number | undefined>(undefined);

/** Rows a panel keeps for its border, title, hints and messages besides a list or form. */
export const PANEL_CHROME_ROWS = 12;

const MIN_LIST_ROWS = 3;

/** `wanted` list/form rows, reduced so the panel still fits the available rows. */
export function fitRows(wanted: number, available: number | undefined): number {
  if (available === undefined) return wanted;
  return Math.max(MIN_LIST_ROWS, Math.min(wanted, available - PANEL_CHROME_ROWS));
}

export const usePanelRows = (): number | undefined => useContext(PanelRowsContext);
