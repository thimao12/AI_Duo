/**
 * Smoke test for the TUI widgets and slash-command panels, rendered with ink-testing-library
 * against a temporary settings file and data directory.
 *   pnpm --filter ai-duo-cli exec tsx src/tui-panels-smoke.ts
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createElement as h, useState, type ReactElement } from 'react';
import { render } from 'ink-testing-library';

// The server modules read these when first imported.
const temp = await mkdtemp(path.join(tmpdir(), 'ai duo tui smoke '));
const settingsPath = path.join(temp, 'nested', 'settings.json');
const workDir = path.join(temp, 'work dir');
const otherDir = path.join(temp, 'other dir');
process.env.AI_DUO_SETTINGS_FILE = settingsPath;
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([temp]);
delete process.env.NO_COLOR;
await Promise.all([mkdir(workDir, { recursive: true }), mkdir(otherDir, { recursive: true }), mkdir(path.join(temp, 'runs'), { recursive: true })]);

const [{ default: SelectList }, { default: TextField, editText }, { default: RolesPanel }, { default: PipelinesPanel }, { default: SettingsPanel }, { default: SessionsPanel }] = await Promise.all([
  import('./tui/widgets/SelectList.tsx'),
  import('./tui/widgets/TextField.tsx'),
  import('./tui/panels/RolesPanel.tsx'),
  import('./tui/panels/PipelinesPanel.tsx'),
  import('./tui/panels/SettingsPanel.tsx'),
  import('./tui/panels/SessionsPanel.tsx'),
]);
const [{ default: UsagePanel }, { default: ConnectionPanel }, { default: ModelPanel }, settings, store, models] = await Promise.all([
  import('./tui/panels/UsagePanel.tsx'),
  import('./tui/panels/ConnectionPanel.tsx'),
  import('./tui/panels/ModelPanel.tsx'),
  import('../../server/src/settings.ts'),
  import('../../server/src/store.ts'),
  import('../../server/src/models.ts'),
]);
type Run = import('../../server/src/types.ts').Run;
type ConnectionStatus = import('../../server/src/types.ts').ConnectionStatus;
type UsageData = import('./tui/panels/UsagePanel.tsx').UsageData;

const KEY = {
  up: '\u001B[A',
  down: '\u001B[B',
  right: '\u001B[C',
  left: '\u001B[D',
  home: '\u001B[H',
  end: '\u001B[F',
  enter: '\r',
  esc: '\u001B',
  tab: '\t',
  backspace: '\u007F',
  ctrlU: '\u0015',
  ctrlD: '\u0004',
};

/** The last frame without colour or inverse-video escape codes. */
const frameOf = (app: App) => stripVTControlCharacters(app.lastFrame() ?? '');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type App = ReturnType<typeof render>;
const apps: App[] = [];

function mount(element: ReactElement): App {
  const app = render(element);
  apps.push(app);
  return app;
}

async function press(app: App, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    app.stdin.write(key);
    await sleep(key === KEY.esc ? 120 : 45);
  }
}

async function typeText(app: App, text: string): Promise<void> {
  app.stdin.write(text);
  await sleep(60);
}

/** Polls the last frame until `check` passes; the failure shows the frame. */
async function until(app: App, check: (frame: string) => boolean, what: string, timeout = 4000): Promise<string> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const frame = frameOf(app);
    if (check(frame)) return frame;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}\n${frame}`);
    await sleep(25);
  }
}
/** Waits for text to show, then a beat so the new view's key handlers are attached. */
const seen = async (app: App, text: string, timeout?: number) => {
  const frame = await until(app, (f) => f.includes(text), `"${text}"`, timeout);
  await sleep(60);
  return frameOf(app) || frame;
};



try {
  // ---- editText (pure).
  const plain = { ctrl: false, meta: false, shift: false } as never;
  assert.deepEqual(editText({ value: 'ab', cursor: 1 }, 'X', plain), { value: 'aXb', cursor: 2 });
  assert.deepEqual(editText({ value: 'a\nb', cursor: 3 }, '', { ...(plain as object), upArrow: true } as never, true), { value: 'a\nb', cursor: 1 });

  // ---- SelectList: navigation, scrolling, current mark, description, filter.
  const rows = Array.from({ length: 15 }, (_, i) => ({ id: `r${i + 1}`, name: `Mục ${String(i + 1).padStart(2, '0')}`, note: `mô tả ${i + 1}` }));
  const chosen: string[] = [];
  let cancelled = 0;
  const list = mount(h(SelectList<(typeof rows)[number]>, {
    items: rows,
    getKey: (r) => r.id,
    getLabel: (r) => r.name,
    getDescription: (r) => r.note,
    isCurrent: (r) => r.id === 'r2',
    onSelect: (r) => chosen.push(r.id),
    onCancel: () => { cancelled += 1; },
    maxHeight: 5,
  }));
  await sleep(50);
  let frame = frameOf(list);
  assert.ok(frame.includes('Mục 01') && frame.includes('Mục 05') && !frame.includes('Mục 06'), `first window\n${frame}`);
  assert.ok(frame.includes('mô tả 1') && frame.includes('● '), 'description column and current mark');
  assert.ok(frame.includes('1/15') && frame.includes('▼'), 'scroll indicator');
  await press(list, KEY.down, KEY.down, 'j', 'j', 'j', 'j', 'j', 'j'); // to row 9
  frame = frameOf(list);
  assert.ok(frame.includes('Mục 09') && !frame.includes('Mục 01'), `scrolled\n${frame}`);
  await press(list, 'k', KEY.up, KEY.enter);
  assert.deepEqual(chosen, ['r7']);
  await press(list, KEY.end);
  assert.ok(frameOf(list).includes('Mục 15'));
  await press(list, KEY.esc);
  assert.equal(cancelled, 1);
  list.unmount();

  const filtered = mount(h(SelectList<(typeof rows)[number]>, { items: rows, getKey: (r) => r.id, getLabel: (r) => r.name, filterable: true, onSelect: (r) => chosen.push(r.id), onCancel: () => { cancelled += 1; }, maxHeight: 5 }));
  await sleep(50);
  await typeText(filtered, '12');
  frame = frameOf(filtered);
  assert.ok(frame.includes('Mục 12') && !frame.includes('Mục 01') && !frame.includes('Mục 13'), `filtered\n${frame}`);
  await press(filtered, KEY.enter);
  assert.equal(chosen.at(-1), 'r12');
  await press(filtered, KEY.esc); // clears the filter, does not cancel
  assert.equal(cancelled, 1);
  assert.ok(frameOf(filtered).includes('Mục 01'));
  await typeText(filtered, 'zzz');
  assert.ok(frameOf(filtered).includes('Không có mục nào'));
  filtered.unmount();

  // ---- TextField: cursor movement, deletion, paste, mask, submit.
  const submitted: string[] = [];
  function Field(props: { mask?: boolean }): ReactElement {
    const [value, setValue] = useState('');
    return h(TextField, { value, onChange: setValue, onSubmit: (v: string) => submitted.push(v), mask: props.mask });
  }
  const field = mount(h(Field, {}));
  await sleep(50);
  await typeText(field, 'abc');
  await press(field, KEY.left, KEY.left);
  await typeText(field, 'X');
  assert.ok(frameOf(field).includes('aXbc'), frameOf(field));
  await press(field, KEY.home);
  await typeText(field, 'Z');
  await press(field, KEY.end, KEY.backspace, KEY.left, KEY.left, KEY.left, KEY.left);
  await press(field, '\u001B[3~'); // Delete
  assert.ok(frameOf(field).includes('aXb') && !frameOf(field).includes('Z'), frameOf(field));
  await typeText(field, 'p\nq');
  assert.ok(frameOf(field).includes('p q'), 'pasted newline becomes a space');
  await press(field, KEY.enter);
  assert.equal(submitted.length, 1);
  assert.ok(submitted[0].includes('p q') && !submitted[0].includes('\n'));
  field.unmount();
  const masked = mount(h(Field, { mask: true }));
  await sleep(50);
  await typeText(masked, 'secret');
  assert.ok(frameOf(masked).includes('••••••') && !frameOf(masked).includes('secret'));
  masked.unmount();

  // ---- Roles: pick, edit + save, validation error, reset.
  const pickedRoles: (string | null)[] = [];
  let closed = 0;
  const roles = mount(h(RolesPanel, { cwd: workDir, onClose: () => { closed += 1; }, onPickRole: (r: { id: string } | null) => pickedRoles.push(r?.id ?? null) }));
  frame = await seen(roles, 'Không dùng vai trò (tự động)');
  assert.ok(frame.includes('Plan') && frame.includes('Claude · opus · high · Chỉ đọc'), frame);
  await press(roles, KEY.down, KEY.enter);
  assert.deepEqual(pickedRoles, ['plan']);
  assert.equal(closed, 1);
  await press(roles, KEY.down, 'e'); // Plan -> Review; edit it
  await seen(roles, 'Prompt mẫu');
  await press(roles, KEY.down, KEY.enter); // Tên
  await press(roles, KEY.ctrlU);
  await typeText(roles, 'Duyệt mã');
  await press(roles, KEY.enter, 's');
  await until(roles, (f) => f.includes('Duyệt mã') && f.includes('Không dùng vai trò'), 'list after save');
  const savedRoles = await settings.getRoles();
  assert.equal(savedRoles.find((r) => r.id === 'review')?.name, 'Duyệt mã');
  assert.ok((await readFile(settingsPath, 'utf8')).includes('Duyệt mã'));
  // Validation error from the server is shown inline and nothing is saved.
  await press(roles, KEY.down, KEY.down, 'e');
  await seen(roles, 'Prompt mẫu');
  await press(roles, KEY.down, KEY.enter, KEY.ctrlU, KEY.enter, 's');
  frame = await seen(roles, 'must be 1-40 characters');
  assert.ok(frame.includes('roles[1].name'), frame);
  assert.equal((await settings.getRoles()).find((r) => r.id === 'review')?.name, 'Duyệt mã');
  await press(roles, KEY.esc);
  await seen(roles, 'Không dùng vai trò');
  // Reset restores the defaults.
  await press(roles, 'r');
  await seen(roles, 'Khôi phục các vai trò mặc định');
  await press(roles, 'y');
  await until(roles, (f) => f.includes('Review') && !f.includes('Duyệt mã'), 'defaults restored');
  assert.equal((await settings.getRoles()).find((r) => r.id === 'review')?.name, 'Review');
  roles.unmount();

  // ---- Pipelines: create, pick, clear.
  const pickedPipelines: (string | null)[] = [];
  const pipes = mount(h(PipelinesPanel, { cwd: workDir, onClose: () => undefined, onPickPipeline: (id: string | null) => pickedPipelines.push(id) }));
  await seen(pipes, 'Không chạy pipeline');
  const before = (await settings.getPipelines()).length;
  await press(pipes, 'n');
  await seen(pipes, 'Tên pipeline');
  await press(pipes, KEY.enter, KEY.ctrlU); // rename
  await typeText(pipes, 'Luồng thử');
  await press(pipes, KEY.enter, 'a'); // second step
  await press(pipes, KEY.right); // its role: the next one
  await press(pipes, 's');
  await until(pipes, (f) => f.includes('Luồng thử') && f.includes('2 bước'), 'pipeline saved');
  const pipelines = await settings.getPipelines();
  assert.equal(pipelines.length, before + 1);
  const created = pipelines.at(-1)!;
  assert.equal(created.name, 'Luồng thử');
  assert.equal(created.steps.length, 2);
  await press(pipes, ...Array.from({ length: pipelines.length }, () => KEY.down), KEY.enter);
  assert.deepEqual(pickedPipelines, [created.id]);
  await press(pipes, KEY.home, KEY.enter);
  assert.deepEqual(pickedPipelines, [created.id, null]);
  pipes.unmount();

  // ---- Settings: edit + save, validation error, unsaved-changes guard.
  let settingsClosed = 0;
  const detector = (agent: 'claude' | 'codex') => Promise.resolve({ name: agent, resolvedPath: `/bin/${agent}`, source: 'path' as const, version: '9.9.9', error: null });
  const panel = mount(h(SettingsPanel, { cwd: workDir, onClose: () => { settingsClosed += 1; }, detector }));
  frame = await seen(panel, 'Đường dẫn CLI');
  await seen(panel, '9.9.9');
  await press(panel, KEY.down, KEY.down, KEY.down, KEY.enter); // Claude: Model mặc định
  await typeText(panel, 'opus');
  await press(panel, KEY.enter, 's');
  await seen(panel, 'Đã lưu.');
  assert.equal((await settings.getCliSettings()).claude.defaultModel, 'opus');
  await press(panel, ...Array.from({ length: 7 }, () => KEY.down), KEY.enter); // Timeout mỗi lượt
  await typeText(panel, '999');
  await press(panel, KEY.enter, 's');
  frame = await seen(panel, 'turnTimeoutMin');
  assert.ok(frame.includes('Có thay đổi chưa lưu'), frame);
  assert.equal((await settings.getCliSettings()).turnTimeoutMin, undefined);
  await press(panel, KEY.esc);
  await seen(panel, 'Bỏ các thay đổi chưa lưu');
  await press(panel, 'n');
  await seen(panel, 'Đường dẫn CLI');
  assert.equal(settingsClosed, 0);
  await press(panel, KEY.esc, 'y');
  assert.equal(settingsClosed, 1);
  panel.unmount();

  // ---- Sessions: list, scope, pick, delete.
  const makeRun = (id: string, cwd: string, title: string, createdAt: number): Run => ({
    id,
    title,
    config: { mode: 'code', prompt: `${title} prompt`, cwd, maxRounds: 1, judge: 'claude', coder: 'codex', turnTimeoutMin: 1 },
    status: 'done',
    createdAt,
    messages: [],
  });
  await store.saveRun(makeRun('run-here', workDir, 'Sửa lỗi đăng nhập', Date.now() - 5 * 60_000));
  await store.saveRun(makeRun('run-else', otherDir, 'Việc ở thư mục khác', Date.now() - 3 * 3_600_000));
  const pickedSessions: string[] = [];
  const sessions = mount(h(SessionsPanel, { cwd: workDir, onClose: () => undefined, onPickSession: (id: string) => pickedSessions.push(id) }));
  frame = await seen(sessions, 'Sửa lỗi đăng nhập');
  assert.ok(!frame.includes('Việc ở thư mục khác'), 'only this folder by default');
  assert.ok(frame.includes('✓') && frame.includes('Code') && frame.includes('work dir') && frame.includes('5 phút trước'), frame);
  await press(sessions, KEY.tab);
  await seen(sessions, 'Việc ở thư mục khác');
  await typeText(sessions, 'khác');
  frame = frameOf(sessions);
  assert.ok(frame.includes('Việc ở thư mục khác') && !frame.includes('Sửa lỗi đăng nhập'), 'typing filters');
  await press(sessions, KEY.enter);
  assert.deepEqual(pickedSessions, ['run-else']);
  await press(sessions, KEY.ctrlD);
  await seen(sessions, 'Xoá phiên');
  await press(sessions, 'y');
  await until(sessions, (f) => !f.includes('Việc ở thư mục khác'), 'deleted run disappears');
  assert.equal(await store.loadRun('run-else'), undefined);
  sessions.unmount();

  // ---- Usage: injected data, colours only via NO_COLOR-aware helper, refresh.
  const soon = new Date(Date.now() + 80 * 60_000).toISOString();
  const data: UsageData = {
    versions: { claude: '2.1.0', codex: null },
    report: {
      claude: { source: 'live', live: true, plan: 'max', fiveHour: { usedPercent: 42, resetsAt: soon, windowMinutes: 300 }, weekly: { usedPercent: 91, windowMinutes: 10_080 } },
      codex: {
        source: 'codex-session-log',
        error: 'needsLogin',
        fiveHour: { usedPercent: 10, windowMinutes: 300, stale: true },
        resetCredits: { availableCount: 2, credits: [{ id: 'c1', title: 'Thẻ reset 1', status: 'available' }, { id: 'c2', title: 'Đã dùng', status: 'redeemed' }] },
      },
    },
  };
  const forces: boolean[] = [];
  const loader = (force: boolean) => {
    forces.push(force);
    return Promise.resolve(data);
  };
  const usage = mount(h(UsagePanel, { cwd: workDir, onClose: () => undefined, loader }));
  frame = await seen(usage, 'Bank reset: 2 lượt');
  assert.ok(frame.includes('Claude') && frame.includes('MAX') && frame.includes('2.1.0') && frame.includes('[trực tiếp]'), frame);
  assert.ok(frame.includes('5 giờ') && frame.includes('▰▰▰▰▰▰▰▰▱') && frame.includes(' 42%') && frame.includes('Tuần') && frame.includes(' 91%'), frame);
  assert.ok(/Reset \d\d:\d\d (hôm nay|ngày mai) · còn 1g (19|20)p/.test(frame), frame);
  assert.ok(frame.includes('[từ log]') && frame.includes('Cần đăng nhập lại') && frame.includes('Đã reset – chưa có số liệu mới') && frame.includes('Thẻ reset 1') && !frame.includes('Đã dùng'), frame);
  assert.ok(frame.includes('chưa kết nối'), 'codex has no version');
  await press(usage, 'r');
  await until(usage, () => forces.includes(true), 'forced refresh');
  usage.unmount();

  // ---- Connection: statuses, guide with exact commands, open login, recheck.
  const status = (agent: 'claude' | 'codex', extra: Partial<ConnectionStatus>): ConnectionStatus => ({ agent, installed: true, version: '1.0.0', path: null, loggedIn: true, method: null, account: null, error: null, ...extra });
  let checks = 0;
  const opened: string[] = [];
  const connection = mount(h(ConnectionPanel, {
    cwd: workDir,
    onClose: () => undefined,
    loader: (agent: 'claude' | 'codex') => {
      checks += 1;
      return Promise.resolve(agent === 'claude' ? status('claude', { installed: false, version: null, loggedIn: null }) : status('codex', { method: 'ChatGPT', account: 'a@b.c' }));
    },
    opener: (agent: 'claude' | 'codex') => {
      opened.push(agent);
      return Promise.resolve('opened' as const);
    },
  }));
  frame = await seen(connection, 'Chưa cài');
  assert.ok(frame.includes('Đã đăng nhập (ChatGPT · a@b.c)'), frame);
  assert.ok(frame.includes('1. Cài CLI: npm i -g @anthropic-ai/claude-code') && frame.includes('2. Đăng nhập: claude auth login') && frame.includes('3. Nhấn r'), frame);
  await press(connection, 'o');
  await seen(connection, 'Đã mở cửa sổ terminal');
  assert.deepEqual(opened, ['claude']);
  const checksBefore = checks;
  await press(connection, 'r');
  await until(connection, () => checks > checksBefore, 'recheck');
  connection.unmount();
  const loggedOut = mount(h(ConnectionPanel, {
    cwd: workDir,
    onClose: () => undefined,
    loader: (agent: 'claude' | 'codex') => Promise.resolve(status(agent, { loggedIn: false })),
    opener: () => Promise.resolve('failed' as const),
  }));
  frame = await seen(loggedOut, 'Đã cài, chưa đăng nhập');
  assert.ok(frame.includes('1. Đăng nhập: claude auth login') && frame.includes('1. Đăng nhập: codex login'), frame);
  loggedOut.unmount();

  // ---- Model overrides.
  const catalog = models.listModels();
  const model0 = catalog.claude.models[0];
  const overridesPicked: object[] = [];
  const modelPanel = mount(h(ModelPanel, { cwd: workDir, onClose: () => undefined, onPickOverrides: (o: object) => overridesPicked.push(o), overrides: { agent: 'codex', permission: 'edit' as const } }));
  frame = await seen(modelPanel, 'Hiện tại: Codex · Sửa file');
  await press(modelPanel, 's');
  assert.deepEqual(overridesPicked.at(-1), { agent: 'codex', permission: 'edit' });
  await press(modelPanel, 'x');
  assert.deepEqual(overridesPicked.at(-1), {});
  modelPanel.unmount();
  const fresh = mount(h(ModelPanel, { cwd: workDir, onClose: () => undefined, onPickOverrides: (o: object) => overridesPicked.push(o) }));
  await seen(fresh, 'Tự động');
  await press(fresh, KEY.right); // agent: Claude
  await press(fresh, KEY.down, KEY.right); // model: first of the catalog
  await press(fresh, KEY.down, KEY.right); // effort: first of that model
  await press(fresh, KEY.down, KEY.right, KEY.right); // permission: Chỉ đọc then Sửa file
  await press(fresh, KEY.left, 's');
  assert.deepEqual(overridesPicked.at(-1), { agent: 'claude', model: model0.id, effort: model0.efforts[0], permission: 'read' });
  fresh.unmount();

  console.log('tui panels smoke passed');
} finally {
  for (const app of apps) app.unmount();
  await rm(temp, { recursive: true, force: true }).catch(() => undefined);
}
