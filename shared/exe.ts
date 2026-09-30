import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/** Absolute path of `name` in the absolute PATH entries, so a relative entry (e.g. `.`) cannot hijack it. */
export function findExecutable(name: string): string | undefined {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    for (const suffix of suffixes) {
      const file = path.join(dir, name + suffix);
      try {
        accessSync(file, constants.X_OK);
        return file;
      } catch { /* not in this directory */ }
    }
  }
  return undefined;
}
