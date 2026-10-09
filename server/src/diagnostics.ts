import path from 'node:path';

export interface Diagnostic {
  /** Path relative to the project, with forward slashes. */
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
  /** Compiler or rule code, e.g. TS2322 or F401. */
  code?: string;
}

const MAX_DIAGNOSTICS = 200;

function relative(cwd: string, file: string): string {
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const rel = path.relative(cwd, abs);
  return (rel.startsWith('..') || path.isAbsolute(rel) ? file : rel).split(path.sep).join('/');
}

type Parser = (output: string, cwd: string) => Diagnostic[];

// src/a.ts(12,5): error TS2322: message
const tsc: Parser = (output, cwd) =>
  [...output.matchAll(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/gm)].map((m) => ({
    file: relative(cwd, m[1]), line: Number(m[2]), column: Number(m[3]), severity: m[4] as Diagnostic['severity'], code: m[5], message: m[6].trim(),
  }));

// ruff --output-format=concise: a.py:1:8: F401 `os` imported but unused
const ruff: Parser = (output, cwd) =>
  [...output.matchAll(/^(.+?):(\d+):(\d+): ([A-Z]+\d+) (.+)$/gm)].map((m) => ({
    file: relative(cwd, m[1]), line: Number(m[2]), column: Number(m[3]), severity: 'error', code: m[4], message: m[5].trim(),
  }));

// ESLint stylish: a file path line, then "  12:5  error  message  rule-name" lines.
const eslint: Parser = (output, cwd) => {
  const found: Diagnostic[] = [];
  let file: string | undefined;
  for (const text of output.split(/\r?\n/)) {
    const entry = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}(\S+))?$/.exec(text);
    if (entry && file) found.push({ file: relative(cwd, file), line: Number(entry[1]), column: Number(entry[2]), severity: entry[3] as Diagnostic['severity'], message: entry[4].trim(), ...(entry[5] && { code: entry[5] }) });
    else if (text.trim() && !/^\s/.test(text) && !/^✖|^\d+ problem/.test(text)) file = text.trim();
  }
  return found;
};

// Biome check headers: src/a.ts:3:5 lint/suspicious/noDoubleEquals ━━━━
const biome: Parser = (output, cwd) =>
  [...output.matchAll(/^(.+?):(\d+):(\d+) (\S+) ━+/gm)].map((m) => ({
    file: relative(cwd, m[1]), line: Number(m[2]), column: Number(m[3]), severity: 'error', code: m[4], message: m[4],
  }));

const PARSERS: Record<string, Parser> = { tsc, ruff, eslint, biome };

/** File/line problems found in a tool's output; empty for an unknown tool or output it cannot read. */
export function parseDiagnostics(tool: string, output: string, cwd: string): Diagnostic[] {
  return (PARSERS[tool]?.(output, cwd) ?? []).slice(0, MAX_DIAGNOSTICS);
}

/** A prompt for an agent to fix the given problems, or empty when there are none. */
export function fixPrompt(diagnostics: readonly Diagnostic[]): string {
  if (!diagnostics.length) return '';
  const lines = diagnostics.map((d) => `- ${d.file}:${d.line}${d.column ? `:${d.column}` : ''} ${d.code ? `[${d.code}] ` : ''}${d.message}`);
  return `Sửa các lỗi sau (chỉ sửa những gì cần thiết, rồi chạy lại công cụ kiểm tra):\n${lines.join('\n')}`;
}
