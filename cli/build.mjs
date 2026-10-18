/**
 * Prepares cli/dist:
 *   ai-duo.mjs – the CLI and the server core it runs on, bundled into one file (no node_modules at runtime)
 *   prompts/   – prompt templates, copied into the user's prompts folder on first use
 */
import { chmod, cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const here = import.meta.dirname;
const root = path.resolve(here, '..');
const dist = path.join(here, 'dist');

// Keep the linked CLI runnable if compilation fails.
const result = await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(dist, 'ai-duo.mjs'),
  write: false,
  bundle: true,
  jsx: 'automatic',
  // Ink loads its devtools bridge only when DEV=true; it is not shipped.
  alias: { 'react-devtools-core': path.join(here, 'src/tui/devtools-stub.mjs') },
  loader: { '.tsx': 'tsx' },
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Some deps still call require() internally.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});

await mkdir(dist, { recursive: true });
await cp(path.join(root, 'server/src/prompts'), path.join(dist, 'prompts'), { recursive: true, filter: (src) => !src.endsWith('.ts') });
await writeFile(path.join(dist, 'ai-duo.mjs'), result.outputFiles[0].contents);
await chmod(path.join(dist, 'ai-duo.mjs'), 0o755);
console.log('cli/dist ready');
