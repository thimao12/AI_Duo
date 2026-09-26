import path from 'node:path';

// In dev `here` is server/src; in the desktop bundle it's the bundle folder, so the
// desktop app points everything elsewhere through env vars (set before this module loads).
const here = import.meta.dirname;

export const paths = {
  dataDir: process.env.AI_DUO_DATA_DIR || path.resolve(here, '../../data/runs'),
  promptsDir: process.env.AI_DUO_PROMPTS_DIR || path.join(here, 'prompts'),
  webDist: process.env.AI_DUO_WEB_DIST || path.resolve(here, '../../web/dist'),
  // pnpm runs the server inside server/; INIT_CWD is where the user actually typed the command.
  defaultCwd: process.env.AI_DUO_DEFAULT_CWD || process.env.INIT_CWD || process.cwd(),
};
