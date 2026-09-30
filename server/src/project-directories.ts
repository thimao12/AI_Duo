import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export class DirectoryAccessError extends Error {}

const within = (root: string, directory: string) => {
  const relative = path.relative(root, directory);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Roots come only from startup configuration, never from a request or a saved run. */
export class ProjectDirectories {
  private readonly roots: { lexical: string; canonical: string }[];

  constructor(raw: string | undefined, defaultCwd: string) {
    let configured: unknown = [path.resolve(defaultCwd)];
    if (raw !== undefined) {
      try { configured = JSON.parse(raw); }
      catch { throw new Error('AI_DUO_ALLOWED_ROOTS must be a JSON array of absolute directory paths'); }
    }
    if (!Array.isArray(configured) || !configured.every((root) => typeof root === 'string' && !root.includes('\u0000') && path.isAbsolute(root))) {
      throw new Error('AI_DUO_ALLOWED_ROOTS must be a JSON array of absolute directory paths');
    }
    this.roots = configured.map((root: string) => {
      const lexical = path.resolve(root);
      try {
        const canonical = realpathSync.native(lexical);
        if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
        return { lexical, canonical };
      } catch {
        throw new Error(`AI_DUO_ALLOWED_ROOTS directory does not exist or is not a directory: ${lexical}`);
      }
    });
  }

  resolve(value: string): string {
    if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) throw new DirectoryAccessError('Invalid working directory');
    const candidate = path.resolve(value.trim());
    if (!this.roots.some((root) => within(root.lexical, candidate) || within(root.canonical, candidate))) {
      throw new DirectoryAccessError(`Working directory is outside AI_DUO_ALLOWED_ROOTS: ${candidate}`);
    }
    let canonical: string;
    try { canonical = realpathSync.native(candidate); }
    catch { throw new DirectoryAccessError(`Working directory not found: ${candidate}`); }
    // Resolve symlinks before stat or process execution, and enforce the configured boundary again.
    if (!this.roots.some((root) => within(root.canonical, canonical))) {
      throw new DirectoryAccessError(`Working directory resolves outside AI_DUO_ALLOWED_ROOTS: ${candidate}`);
    }
    if (!statSync(canonical).isDirectory()) throw new DirectoryAccessError(`Working directory is not a directory: ${candidate}`);
    return canonical;
  }
}

let policy: ProjectDirectories | undefined;
export function projectDirectories(defaultCwd = process.env.AI_DUO_DEFAULT_CWD || process.env.INIT_CWD || process.cwd()): ProjectDirectories {
  policy ??= new ProjectDirectories(process.env.AI_DUO_ALLOWED_ROOTS, defaultCwd);
  return policy;
}

export const authorizeDirectory = (cwd: string): string => projectDirectories().resolve(cwd);
