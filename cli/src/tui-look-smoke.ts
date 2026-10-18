/**
 * Look-and-feel smoke test: themes, the logo, unified-diff parsing and rendering, edits made by
 * Claude, and command output folded under its call.
 *   pnpm --filter ai-duo-cli test
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';

process.env.NO_COLOR = '1';
const { render, cleanup } = await import('ink-testing-library');
const { THEMES, ANSI_THEME, findTheme, gradientAt, supportsTrueColor } = await import('./tui/themes.ts');
const { activeTheme, setTheme, tone } = await import('./tui/theme.ts');
const { LOGO_ROWS, LOGO_WIDTH, logoRow, plainLogoRow } = await import('./tui/Logo.tsx');
const { parseDiff, diffTexts, countChanges } = await import('./tui/diff.ts');
const { FileDiffView, DiffView } = await import('./tui/DiffView.tsx');
const { toPartItems, MessageView } = await import('./tui/MessageView.tsx');
const { editsOf } = await import('../../server/src/agents/claude.ts');
const { validateCliSettings } = await import('../../server/src/cli-settings.ts');

let failed = false;
const step = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${name}\n${(err as Error).stack}`);
  } finally {
    cleanup();
  }
};

await step('themes: every theme fills every role with a hex colour and a logo gradient', () => {
  assert.ok(THEMES.length >= 8);
  const hex = /^#[0-9a-f]{6}$/i;
  const ids = new Set<string>();
  for (const theme of THEMES) {
    assert.ok(!ids.has(theme.id), `duplicate id ${theme.id}`);
    ids.add(theme.id);
    for (const [role, color] of Object.entries(theme.colors)) assert.match(color, hex, `${theme.id}.${role}`);
    for (const color of [...Object.values(theme.diff), ...theme.logo.warm, ...theme.logo.cool]) assert.match(color, hex, theme.id);
  }
  assert.equal(findTheme('dracula')?.label, 'Dracula');
  assert.equal(findTheme('nope'), undefined);
  assert.equal(findTheme('default'), ANSI_THEME);
  assert.equal(gradientAt(['#000000', '#ffffff'], 0.5), '#808080');
  assert.equal(gradientAt(['#ff0000', '#00ff00', '#0000ff'], 1), '#0000ff');
  assert.equal(gradientAt(['yellow', 'red'], 0), 'yellow', 'named colours are picked, not blended');
});

await step('themes: truecolor detection, switching, NO_COLOR', () => {
  assert.equal(supportsTrueColor({ COLORTERM: 'truecolor' }), true);
  assert.equal(supportsTrueColor({ WT_SESSION: 'x' }), true);
  assert.equal(supportsTrueColor({ TERM: 'xterm' }), false);
  assert.equal(tone('red'), undefined, 'NO_COLOR gives plain text');
  delete process.env.NO_COLOR;
  assert.equal(setTheme('nope'), false);
  const before = activeTheme().id;
  const ok = setTheme('nord');
  const expected = supportsTrueColor() ? '#bf616a' : 'red';
  assert.equal(ok, true);
  assert.equal(tone('red'), expected);
  setTheme(before);
  process.env.NO_COLOR = '1';
});

await step('theme setting is validated and saved with the CLI settings', () => {
  assert.equal((validateCliSettings({ theme: 'tokyo-night' }) as { theme?: string }).theme, 'tokyo-night');
  assert.equal((validateCliSettings({ theme: '' }) as { theme?: string }).theme, undefined);
  assert.match(String(validateCliSettings({ theme: 'No Such!' })), /theme/);
  assert.match(String(validateCliSettings({ theme: 3 })), /theme/);
});

await step('logo: two interlocking A letters drawn with strokes, theme gradient', () => {
  assert.equal(LOGO_ROWS, 6);
  const rows = Array.from({ length: LOGO_ROWS }, (_, row) => plainLogoRow(row));
  for (const row of rows) assert.equal(row.length, LOGO_WIDTH);
  assert.ok(rows[0].trim().length > 0 && rows[5].trim().length > 0);
  const { logo } = findTheme('tokyo-night')!;
  const top = logoRow(0, logo.warm, logo.cool).filter((c) => c.color);
  assert.ok(top.every((c) => c.char === '╱' || c.char === '╲'), 'the apexes are drawn from diagonal strokes');
  const colours = new Set(Array.from({ length: LOGO_ROWS }, (_, r) => logoRow(r, logo.warm, logo.cool).map((c) => c.color).join()).values());
  assert.ok(colours.size > 3, 'the gradient changes from row to row');
});

const SAMPLE = [
  'diff --git a/src/lib.rs b/src/lib.rs',
  'index 111..222 100644',
  '--- a/src/lib.rs',
  '+++ b/src/lib.rs',
  '@@ -31,5 +31,6 @@ fn summarize',
  ' fn summarize(users: &[User]) -> String {',
  '-    let active = users.iter().filter(|u| u.is_active).count();',
  '+    let active = users.iter().filter(|u| u.is_active()).count();',
  '     let names = users.len();',
  '-    format!("{} active: {}", active, names)',
  '+    format!("{active} active users: {}", names)',
  '+        .trim()',
  ' }',
  '@@ -90,2 +91,2 @@',
  ' tail',
  '-old',
  '+new',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
].join('\n');

await step('parseDiff: files, line numbers, hunks, notes', () => {
  const files = parseDiff(SAMPLE);
  assert.deepEqual(files.map((f) => [f.path, f.added, f.removed]), [['src/lib.rs', 4, 3], ['img.png', 0, 0], ['new.txt', 2, 0]]);
  const lib = files[0].lines;
  assert.deepEqual(lib[0], { kind: 'ctx', oldNo: 31, newNo: 31, text: 'fn summarize(users: &[User]) -> String {' });
  assert.deepEqual(lib[1], { kind: 'del', oldNo: 32, text: '    let active = users.iter().filter(|u| u.is_active).count();' });
  assert.deepEqual(lib[2], { kind: 'add', newNo: 32, text: '    let active = users.iter().filter(|u| u.is_active()).count();' });
  assert.ok(lib.some((l) => l.text === '…' && l.oldNo === undefined), 'a gap marker separates hunks');
  assert.equal(lib.at(-1)?.newNo, 92);
  assert.equal(files[1].note, 'binary file');
  assert.equal(files[2].note, 'new file');
  assert.deepEqual(parseDiff(undefined), []);
  assert.deepEqual(parseDiff(''), []);
});

await step('diffTexts: LCS diff with context, new files, identical texts', () => {
  const lines = diffTexts('a\nb\nc\nd\ne\nf\ng', 'a\nb\nX\nd\ne\nf\ng', 1);
  assert.deepEqual(lines.map((l) => `${l.kind}:${l.text}`), ['ctx:b', 'del:c', 'add:X', 'ctx:d'], 'one line of context around the change');
  assert.deepEqual(countChanges(lines), { added: 1, removed: 1 });
  const created = diffTexts('', 'x\ny');
  assert.deepEqual(created.map((l) => l.kind), ['add', 'add']);
  assert.deepEqual(diffTexts('same', 'same'), []);
  const gap = diffTexts(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 20 }, (_, i) => (i === 0 || i === 19 ? `X${i}` : `l${i}`)).join('\n'), 1);
  assert.ok(gap.some((l) => l.text === '…'), 'far apart changes get a gap marker');
});

await step('DiffView renders numbers, markers and a cap (plain)', () => {
  const [lib] = parseDiff(SAMPLE);
  const out = render(createElement(FileDiffView, { file: lib, width: 100, maxRows: 5 })).lastFrame() ?? '';
  assert.match(out, /src\/lib\.rs \+4 −3/);
  assert.match(out, /31\s+fn summarize/);
  assert.match(out, /32 -\s+let active = users\.iter\(\)\.filter\(\|u\| u\.is_active\)\.count/);
  assert.match(out, /32 \+\s+let active = users\.iter\(\)\.filter\(\|u\| u\.is_active\(\)\)\.count/);
  assert.match(out, /… \d+ more line\(s\)/);
  const long = render(createElement(DiffView, { lines: [{ kind: 'add', newNo: 1, text: 'x'.repeat(300) }], width: 40 })).lastFrame() ?? '';
  assert.ok(long.split('\n').every((l) => l.length <= 40), 'a long line is cut to the width');
});

await step('Claude edits: Edit, MultiEdit and Write carry old/new text', () => {
  assert.deepEqual(editsOf('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }), [{ path: 'a.ts', oldText: 'x', newText: 'y' }]);
  assert.deepEqual(editsOf('MultiEdit', { file_path: 'a.ts', edits: [{ old_string: '1', new_string: '2' }, { old_string: 'a', new_string: 'b' }] }).map((e) => e.newText), ['2', 'b']);
  assert.deepEqual(editsOf('Write', { file_path: 'n.ts', content: 'hi' }), [{ path: 'n.ts', oldText: '', newText: 'hi' }]);
  assert.deepEqual(editsOf('Read', { file_path: 'a.ts' }), []);
  assert.deepEqual(editsOf('Edit', { old_string: 'x', new_string: 'y' }), [], 'no path, no edit');
});

await step('tool output is shown under shell calls only, with the exit code', () => {
  const items = toPartItems(
    [
      { kind: 'tool', content: 'Shell: npm test' },
      { kind: 'tool_result', content: 'exit 1\nline 1\nline 2' },
      { kind: 'tool', content: 'Read: a.ts' },
      { kind: 'tool_result', content: 'file contents that should stay hidden' },
      { kind: 'tool', content: 'Edit: a.ts', edit: { path: 'a.ts', oldText: 'x', newText: 'y' } },
    ],
    false,
  );
  assert.equal(items[0].output, 'exit 1\nline 1\nline 2');
  assert.equal(items[1].output, undefined);
  assert.equal(items[2].edit?.path, 'a.ts');
  const message = {
    id: 'm1', agent: 'claude' as const, phase: 'code', round: 1, title: 'Claude codes', status: 'done' as const, startedAt: 0, endedAt: 1,
    parts: [
      { kind: 'tool' as const, content: 'Bash: npm test' },
      { kind: 'tool_result' as const, content: Array.from({ length: 12 }, (_, i) => `out ${i}`).join('\n') },
      { kind: 'tool' as const, content: 'Edit: a.ts', edit: { path: 'a.ts', oldText: 'old line', newText: 'new line' } },
    ],
  };
  const out = render(createElement(MessageView, { message, width: 80 })).lastFrame() ?? '';
  assert.match(out, /\$ Bash: npm test/);
  assert.match(out, /│ out 0/);
  assert.match(out, /… 4 more line\(s\)/);
  assert.match(out, /a\.ts \+1 −1/);
  assert.match(out, /-\s+old line/);
  assert.match(out, /\+\s+new line/);
});

if (failed) process.exit(1);
console.log('TUI look smoke test passed');
process.exit(0);
