import path from 'node:path';
import { appDataRoot } from './app-data.ts';

// In dev `here` is server/src; in the desktop and CLI bundles it's the bundle folder, so those
// entry points point everything elsewhere through env vars (set before this module loads).
const here = import.meta.dirname;

export const paths = {
  // Shared with the desktop app and the CLI; set AI_DUO_DATA_DIR to use another history (e.g. the old data/runs).
  dataDir: process.env.AI_DUO_DATA_DIR || path.join(appDataRoot(), 'runs'),
  promptsDir: process.env.AI_DUO_PROMPTS_DIR || path.join(here, 'prompts'),
  webDist: process.env.AI_DUO_WEB_DIST || path.resolve(here, '../../web/dist'),
  // pnpm runs the server inside server/; INIT_CWD is where the user actually typed the command.
  defaultCwd: process.env.AI_DUO_DEFAULT_CWD || process.env.INIT_CWD || process.cwd(),
};
