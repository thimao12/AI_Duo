#!/usr/bin/env node
// Launcher: the real CLI is the bundle in dist/. When it is missing (never built, or a build was
// interrupted) say how to rebuild instead of failing with MODULE_NOT_FOUND.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = fileURLToPath(new URL('../dist/ai-duo.mjs', import.meta.url));
if (!existsSync(entry)) {
  const folder = fileURLToPath(new URL('..', import.meta.url));
  console.error(`ai-duo: the build is missing (${entry}).\nRebuild it with:  npm run build --prefix "${folder}"`);
  process.exit(1);
}
await import(pathToFileURL(entry).href);
