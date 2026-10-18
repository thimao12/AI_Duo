/**
 * Smoke test for skill and custom-command discovery: front matter, project over user precedence,
 * template expansion and the routes' directory check.
 *   pnpm --filter server test:extensions
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expandCommand, listCommands, listSkills, parseFrontMatter } from './extensions.ts';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo extensions smoke '));
try {
  const project = path.join(temp, 'project');
  const home = path.join(temp, 'home');
  const write = async (file: string, text: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };

  assert.deepEqual(parseFrontMatter('no front matter'), { meta: {}, body: 'no front matter' });
  assert.deepEqual(parseFrontMatter('---\r\nname: "x"\r\nDescription: y z\r\n---\r\nbody'), { meta: { name: 'x', description: 'y z' }, body: 'body' });

  await write(path.join(project, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship it\n---\nSteps');
  await write(path.join(home, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\ndescription: user copy\n---\n');
  await write(path.join(home, '.claude', 'skills', 'notes', 'SKILL.md'), 'plain, no front matter');
  await write(path.join(home, '.claude', 'skills', 'bad name!', 'SKILL.md'), 'ignored');
  await write(path.join(home, '.claude', 'skills', 'empty', 'README.md'), 'no SKILL.md');
  const skills = await listSkills(project, home);
  assert.deepEqual(skills.map((s) => [s.name, s.scope, s.description]), [['deploy', 'project', 'Ship it'], ['notes', 'user', '']]);
  assert.deepEqual(await listSkills(path.join(temp, 'missing'), path.join(temp, 'nohome')), []);

  const userCommands = path.join(temp, 'user-commands');
  await write(path.join(project, '.ai-duo', 'commands', 'review.md'), '---\ndescription: Review a file\n---\nReview $ARGUMENTS carefully.');
  await write(path.join(userCommands, 'review.md'), 'user review');
  await write(path.join(userCommands, 'fix.md'), 'Fix the bug');
  await write(path.join(userCommands, 'empty.md'), '---\ndescription: nothing\n---\n');
  await write(path.join(userCommands, 'not a name.md'), 'ignored');
  await write(path.join(userCommands, 'notes.txt'), 'ignored');
  const commands = await listCommands(project, userCommands);
  assert.deepEqual(commands.map((c) => [c.name, c.scope, c.description]), [['fix', 'user', ''], ['review', 'project', 'Review a file']]);
  assert.equal(expandCommand(commands[1], ' src/a.ts '), 'Review src/a.ts carefully.');
  assert.equal(expandCommand(commands[0], 'now'), 'Fix the bug\n\nnow');
  assert.equal(expandCommand(commands[0], ''), 'Fix the bug');

  console.log('PASS extensions: front matter, skills, custom commands, precedence');
} finally {
  await rm(temp, { recursive: true, force: true });
}
