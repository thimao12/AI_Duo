import { createElement } from 'react';
import type { PanelProps, SlashCommand } from './panel-types.ts';
import ConnectionPanel from './panels/ConnectionPanel.tsx';
import ModelPanel from './panels/ModelPanel.tsx';
import PipelinesPanel from './panels/PipelinesPanel.tsx';
import RolesPanel from './panels/RolesPanel.tsx';
import SessionsPanel from './panels/SessionsPanel.tsx';
import SettingsPanel from './panels/SettingsPanel.tsx';
import UsagePanel from './panels/UsagePanel.tsx';

/**
 * Commands of the slash menu. Entries without `panel` are handled by the shell (App.tsx):
 * help, clear, new, exit and skip-auth. Names carry no leading slash.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'Show commands and key bindings' },
  { name: 'clear', description: 'Clear the screen (the session continues)' },
  { name: 'new', description: 'Start a new session' },
  { name: 'sessions', description: 'Browse and resume earlier sessions', panel: (p: PanelProps) => createElement(SessionsPanel, p) },
  { name: 'resume', description: 'Resume an earlier session (same as /sessions)', panel: (p: PanelProps) => createElement(SessionsPanel, p) },
  { name: 'roles', description: 'Pick or edit roles (Plan, Review, Code…)', panel: (p: PanelProps) => createElement(RolesPanel, p) },
  { name: 'pipelines', description: 'Pick or edit pipelines', panel: (p: PanelProps) => createElement(PipelinesPanel, p) },
  { name: 'model', description: 'Choose agent, model, effort and permission', panel: (p: PanelProps) => createElement(ModelPanel, p) },
  { name: 'usage', description: 'Claude and Codex usage limits', panel: (p: PanelProps) => createElement(UsagePanel, p) },
  { name: 'login', description: 'Check and connect the Claude and Codex CLIs', panel: (p: PanelProps) => createElement(ConnectionPanel, p) },
  { name: 'settings', description: 'Per-CLI settings', panel: (p: PanelProps) => createElement(SettingsPanel, p) },
  { name: 'paste-image', description: 'Attach an image from the clipboard (also Ctrl+V / Alt+V)' },
  { name: 'clear-images', description: 'Remove the attached images' },
  { name: 'skip-auth', description: 'Toggle running although a CLI cannot report its login' },
  { name: 'exit', description: 'Leave AI Duo' },
];

/** Commands matching what was typed after the slash: prefix matches first, then substring matches. */
export function filterCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  const starts = commands.filter((c) => c.name.startsWith(q));
  const contains = commands.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.description.toLowerCase().includes(q)));
  return [...starts, ...contains];
}

export function findCommand(commands: readonly SlashCommand[], name: string): SlashCommand | undefined {
  return commands.find((c) => c.name === name.toLowerCase());
}

export const HELP_LINES: readonly string[] = [
  'Keys:',
  String.raw`  Enter send · Alt+Enter / Ctrl+J / trailing \ + Enter new line`,
  '  Up/Down history (at the first/last line) · Ctrl+A/E line start/end · Alt+B/F or Ctrl+←/→ words',
  '  Tab (empty prompt) next role · Shift+Tab Code/Plan · Esc closes a panel',
  '  Ctrl+V or Alt+V attach an image from the clipboard (or /paste-image) · paste or drop an image file path (png, jpg, webp, gif; up to 4, 5 MB each)',
  '  Backspace at the start of the prompt removes the last image · /clear-images removes all',
  '  ! as the first character: shell mode · Enter runs the command here (not sent to the agents) · Esc or Backspace on empty leaves it',
  '  Ctrl+C stops the run or shell command (again: quit) · Ctrl+D on an empty prompt quits',
];
