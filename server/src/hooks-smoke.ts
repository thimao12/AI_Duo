/**
 * Smoke test for turn hooks: validation, the command's cwd and AI_DUO_* variables, failure reporting.
 *   pnpm --filter server test:hooks
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo hooks smoke '));
process.env.AI_DUO_SETTINGS_FILE = path.join(temp, 'settings.json');
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
try {
  const [{ validateCliSettings }, settings, { runHook, editedFiles }] = await Promise.all([import('./cli-settings.ts'), import('./settings.ts'), import('./hooks.ts')]);
  const bad = (input: unknown, pattern: RegExp) => {
    const result = validateCliSettings(input);
    assert.equal(typeof result, 'string');
    assert.match(result as string, pattern);
  };
  bad({ hooks: 'x' }, /đối tượng/);
  bad({ hooks: { afterSave: 'x' } }, /không hợp lệ/);
  bad({ hooksBlock: 'yes' }, /hooksBlock/);
  assert.equal((validateCliSettings({ hooks: { afterEdit: 'npm run format' }, hooksBlock: true }) as { hooksBlock?: boolean }).hooksBlock, true);
  assert.equal((validateCliSettings({ hooksBlock: false }) as { hooksBlock?: boolean }).hooksBlock, undefined);
  bad({ hooks: { beforeTurn: 1 } }, /chuỗi/);
  bad({ hooks: { beforeTurn: 'x'.repeat(501) } }, /tối đa 500/);
  assert.deepEqual((validateCliSettings({ hooks: { beforeTurn: ' echo hi ', afterTurn: '  ' } }) as { hooks: unknown }).hooks, { beforeTurn: 'echo hi' });

  assert.equal(await runHook('beforeTurn', temp, {}), undefined, 'no hook configured');

  const node = JSON.stringify(process.execPath);
  const script = (code: string) => `${node} -e ${JSON.stringify(code)}`;
  const saved = await settings.setCliSettings({
    hooks: {
      beforeTurn: script("process.stdout.write(process.cwd() + '|' + process.env.AI_DUO_AGENT + '|' + process.env.AI_DUO_ROLE + '|' + process.env.AI_DUO_HOOK)"),
      afterTurn: script("console.error('boom'); process.exit(3)"),
    },
  });
  assert.equal(typeof saved, 'object');

  const before = await runHook('beforeTurn', temp, { agent: 'claude', role: 'coder' });
  assert.equal(before?.ok, true);
  assert.equal(before?.output.split('|').slice(1).join('|'), 'claude|coder|beforeTurn');
  assert.equal(path.resolve(before!.output.split('|')[0]), path.resolve(temp), 'runs in the project folder');

  const after = await runHook('afterTurn', temp, {});
  assert.equal(after?.ok, false);
  assert.match(after?.output ?? '', /boom/);

  // afterEdit waits for a file edit: Claude's Edit family, Codex's file changes, or an edit record.
  const tool = (content: string, edit?: unknown) => ({ kind: 'tool', content, ...(edit ? { edit } : {}) });
  assert.equal(editedFiles([tool('Edit: a.ts'), { kind: 'text', content: 'x' }]), true);
  assert.equal(editedFiles([tool('MultiEdit: a.ts')]), true);
  assert.equal(editedFiles([tool('Write: a.ts')]), true);
  assert.equal(editedFiles([tool('Edit files:\nupdate a.ts')]), true);
  assert.equal(editedFiles([tool('Bash: ls', { path: 'a' })]), true);
  assert.equal(editedFiles([tool('Read: a.ts'), tool('Bash: npm test'), tool('Editor: x')]), false);
  assert.equal(editedFiles([]), false);

  console.log('PASS hooks: validation, cwd and variables, failure output');
} finally {
  await rm(temp, { recursive: true, force: true });
}
