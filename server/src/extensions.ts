import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { paths } from './paths.ts';

/** Skills (`<dir>/<name>/SKILL.md`) and custom slash commands (`<dir>/<name>.md`) found on disk. */

export interface Skill {
  name: string;
  description: string;
  scope: 'project' | 'user';
  /** Absolute path of the SKILL.md. */
  file: string;
}
export interface SlashCommand {
  name: string;
  description: string;
  scope: 'project' | 'user';
  /** Prompt template; `$ARGUMENTS` is replaced by what follows the command. */
  template: string;
}

const MAX_FILE_BYTES = 64 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** `---` front matter as flat `key: value` lines, plus the rest of the text. */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1].toLowerCase()] = pair[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { meta, body: text.slice(match[0].length) };
}

function readSmall(file: string): string | undefined {
  try {
    const text = readFileSync(file, 'utf8');
    return text.length > MAX_FILE_BYTES ? undefined : text;
  } catch {
    return undefined;
  }
}

function names(dir: string): import('node:fs').Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Project skills win over user skills of the same name. */
export function listSkillsSync(cwd: string, home = homedir()): Skill[] {
  const roots: [string, Skill['scope']][] = [
    [path.join(cwd, '.claude', 'skills'), 'project'],
    [path.join(cwd, '.agents', 'skills'), 'project'],
    [path.join(home, '.claude', 'skills'), 'user'],
    [path.join(home, '.agents', 'skills'), 'user'],
  ];
  const found = new Map<string, Skill>();
  for (const [root, scope] of roots) {
    for (const entry of names(root)) {
      if (!entry.isDirectory() || !NAME.test(entry.name) || found.has(entry.name)) continue;
      const file = path.join(root, entry.name, 'SKILL.md');
      const text = readSmall(file);
      if (text === undefined) continue;
      const { meta } = parseFrontMatter(text);
      found.set(entry.name, { name: meta.name && NAME.test(meta.name) ? meta.name : entry.name, description: meta.description ?? '', scope, file });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const listSkills = async (cwd: string, home = homedir()): Promise<Skill[]> => listSkillsSync(cwd, home);

/** Project commands win over user commands of the same name. */
export async function listCommands(cwd: string, userDir = path.join(paths.dataDir, 'commands')): Promise<SlashCommand[]> {
  const roots: [string, SlashCommand['scope']][] = [[path.join(cwd, '.ai-duo', 'commands'), 'project'], [userDir, 'user']];
  const found = new Map<string, SlashCommand>();
  for (const [root, scope] of roots) {
    for (const entry of names(root)) {
      const name = entry.name.replace(/\.md$/i, '');
      if (!entry.isFile() || !/\.md$/i.test(entry.name) || !NAME.test(name) || found.has(name)) continue;
      const text = readSmall(path.join(root, entry.name));
      if (text === undefined) continue;
      const { meta, body } = parseFrontMatter(text);
      const template = body.trim();
      if (template) found.set(name, { name, description: meta.description ?? '', scope, template });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The prompt a command stands for; without `$ARGUMENTS` in the template the arguments are appended. */
export function expandCommand(command: Pick<SlashCommand, 'template'>, args: string): string {
  const text = args.trim();
  if (command.template.includes('$ARGUMENTS')) return command.template.split('$ARGUMENTS').join(text);
  return text ? `${command.template}\n\n${text}` : command.template;
}

const SKILL_MENTION = /(^|[\s(])\$([A-Za-z0-9][\w-]{0,63})/g;
const MAX_SKILLS = 3;

/**
 * `$skill-name` in a prompt attaches that skill's instructions (its SKILL.md without the front matter),
 * for every agent alike; a name that is not a skill (`$5`, `$HOME`) is left alone.
 */
export function expandSkills(prompt: string, cwd: string, home = homedir()): string {
  if (!prompt.includes('$')) return prompt;
  const skills = listSkillsSync(cwd, home);
  if (!skills.length) return prompt;
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(SKILL_MENTION)) {
    if (blocks.length >= MAX_SKILLS) break;
    const skill = skills.find((s) => s.name === match[2]);
    if (!skill || seen.has(skill.name)) continue;
    const text = readSmall(skill.file);
    if (text === undefined) continue;
    seen.add(skill.name);
    blocks.push(`### Skill ${skill.name}\n${parseFrontMatter(text).body.trim()}`);
  }
  return blocks.length ? `${prompt}\n\nSkills named with $ (follow their instructions):\n\n${blocks.join('\n\n')}` : prompt;
}
