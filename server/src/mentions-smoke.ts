/**
 * Smoke test for @file mentions and cross-agent project instructions.
 *   pnpm --filter server test:mentions
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expandMentions, projectContext } from './mentions.ts';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo mentions smoke '));
try {
  const project = path.join(temp, 'project');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(project, 'b.md'), '# B\n');
  await writeFile(path.join(project, 'bin.dat'), Buffer.from([1, 0, 2]));
  await writeFile(path.join(project, 'big.txt'), 'x'.repeat(70 * 1024));
  await writeFile(path.join(temp, 'secret.txt'), 'outside');

  const out = expandMentions('Fix @src/a.ts and see (@b.md), mail me@example.com', project);
  assert.match(out, /^Fix @src\/a\.ts and see \(@b\.md\), mail me@example\.com\n\nFiles mentioned with @/);
  assert.match(out, /### src\/a\.ts\n```\nexport const a = 1;\n```/);
  assert.match(out, /### b\.md\n```\n# B\n```/);
  assert.equal(out.includes('example.com\n\n### example'), false, 'an e-mail address is not a mention');

  assert.equal(expandMentions('no mentions here', project), 'no mentions here');
  assert.equal(expandMentions('@missing.ts @bin.dat @big.txt', project), '@missing.ts @bin.dat @big.txt', 'missing, binary and large files are left alone');
  assert.equal(expandMentions('@../secret.txt', project), '@../secret.txt', 'outside the project');
  assert.equal(expandMentions('@src', project), '@src', 'a folder is not a file');
  assert.equal(expandMentions(`@${path.join(temp, 'secret.txt')}`, project), `@${path.join(temp, 'secret.txt')}`, 'absolute paths are not mentions');
  assert.equal((expandMentions('@src/a.ts @src/a.ts', project).match(/### src\/a\.ts/g) ?? []).length, 1, 'a repeated mention is attached once');
  const many = Array.from({ length: 8 }, (_, i) => `f${i}.txt`);
  for (const name of many) await writeFile(path.join(project, name), name);
  assert.equal((expandMentions(many.map((n) => `@${n}`).join(' '), project).match(/^### /gm) ?? []).length, 5, 'at most five files');

  // A link out of the project must not leak the target.
  const linked = await symlink(path.join(temp, 'secret.txt'), path.join(project, 'link.txt')).then(() => true, () => false);
  if (linked) assert.equal(expandMentions('@link.txt', project), '@link.txt', 'a symlink to outside is refused');

  // Project instructions: each agent gets the file it does not load itself.
  assert.equal(projectContext('claude', project), '');
  await writeFile(path.join(project, 'AGENTS.md'), 'Use tabs.\n');
  assert.equal(projectContext('codex', project), '', 'Codex loads AGENTS.md itself');
  assert.match(projectContext('claude', project), /Project instructions \(AGENTS\.md\):\n\nUse tabs\./);
  assert.match(projectContext('antigravity', project), /Use tabs\./);
  await writeFile(path.join(project, 'CLAUDE.md'), 'Use spaces.\n');
  assert.equal(projectContext('claude', project), '', 'Claude loads CLAUDE.md itself');
  await rm(path.join(project, 'AGENTS.md'));
  assert.match(projectContext('codex', project), /\(CLAUDE\.md\):\n\nUse spaces\./);

  console.log('PASS mentions: @file expansion limits and confinement, cross-agent project instructions');
} finally {
  await rm(temp, { recursive: true, force: true });
}
