/**
 * TUI smoke test.
 *   pnpm --filter ai-duo-cli test
 *
 * Drives the Ink chat UI with ink-testing-library against a fake RunService (scripted events, no
 * agent CLIs): editing, history, slash menu, role and mode keys, streamed replies, Plan and Pair
 * decisions, Ctrl+C, and a clean exit through startTui() on fake terminal streams.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import type { RunHandle, RunRequest, StartOptions } from '../../server/src/service.ts';
import { applyAgentEvent, type Message, type PlanDecisionAnswer, type Run, type RunEvent } from '../../server/src/types.ts';

const temp = await mkdtemp(path.join(tmpdir(), 'ai duo tui smoke '));
process.env.NO_COLOR = '1';
process.env.AI_DUO_DATA_DIR = path.join(temp, 'runs');
process.env.AI_DUO_SETTINGS_FILE = path.join(temp, 'settings.json');
process.env.AI_DUO_ALLOWED_ROOTS = JSON.stringify([temp]);

// Loaded after the environment is set: the server modules read it when they load.
const { render, cleanup } = await import('ink-testing-library');
const { App } = await import('./tui/App.tsx');
const { startTui } = await import('./tui/index.tsx');
const editor = await import('./tui/editor.ts');
const { addToHistory, loadHistory } = await import('./tui/history.ts');
const { parseBlocks, parseInline } = await import('./tui/Markdown.tsx');
const { buildRequest } = await import('./tui/requestBuilder.ts');
const { ServiceError } = await import('../../server/src/service.ts');
type ChatService = import('./tui/useSession.ts').ChatService;

/* ---- Fake RunService ---- */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(done: () => boolean, what: string, tries = 150): Promise<void> {
  if (done()) return;
  if (tries <= 0) throw new Error(`timed out waiting for ${what}`);
  await sleep(20);
  return until(done, what, tries - 1);
}

interface Seen {
  kind: 'start' | 'continue';
  id?: string;
  request: RunRequest;
}

class FakeService {
  seen: Seen[] = [];
  cancels = 0;
  answers: PlanDecisionAnswer[] = [];
  pairAnswers: boolean[] = [];
  /** When set, approving the plan fails with this message (a folder that is not a Git repository). */
  approveRefusal?: string;
  private readonly runs = new Map<string, Run>();
  private counter = 0;

  start = async (request: RunRequest, options: StartOptions = {}): Promise<RunHandle> => {
    this.seen.push({ kind: 'start', request });
    const id = `run-${++this.counter}`;
    const run: Run = {
      id,
      config: { mode: (request.mode as Run['config']['mode']) ?? 'code', prompt: request.prompt ?? '', cwd: request.cwd ?? temp, maxRounds: 2, judge: 'claude', coder: 'claude', turnTimeoutMin: 30 },
      status: 'running',
      createdAt: Date.now(),
      messages: [],
    };
    this.runs.set(id, run);
    return this.launch(run, request, options);
  };

  continue = async (id: string, request: RunRequest, options: StartOptions = {}): Promise<RunHandle> => {
    this.seen.push({ kind: 'continue', id, request });
    const run = this.runs.get(id);
    if (!run) throw new ServiceError('not_found', 'not found');
    run.status = 'running';
    return this.launch(run, request, options);
  };

  get = async (id: string) => this.runs.get(id);
  preflight = async () => ({ ok: true, checks: [], problems: [], authUnverified: false });
  previewRoute = async () => ({ mode: 'code' as const, coder: 'codex' as const, reviewer: 'claude' as const, maxRounds: 2, route: {} as never, askHaiku: false });
  abortAll = async () => {};

  /** Waits for the plan decision; a refinement produces a revised plan and asks again. */
  private async askPlan(
    patch: (p: Extract<RunEvent, { type: 'run.update' }>['patch']) => void,
    say: (title: string, chunks: string[]) => Promise<void>,
    wait: (resolve: (a: PlanDecisionAnswer) => void) => void,
    revision: number,
  ): Promise<PlanDecisionAnswer> {
    patch({ planDecision: { type: 'plan-approval', reviewRounds: 1, revision } });
    const answer = await new Promise<PlanDecisionAnswer>(wait);
    patch({ planDecision: null });
    if (answer.action !== 'refine') return answer;
    await say('Claude revises', ['revised plan']);
    return this.askPlan(patch, say, wait, revision + 1);
  }

  private launch(run: Run, request: RunRequest, options: StartOptions): RunHandle {
    options.onCreated?.(structuredClone(run));
    let cancelled = false;
    let decide: ((answer: PlanDecisionAnswer) => void) | undefined;
    let pairDecide: ((go: boolean) => void) | undefined;
    const emit = (event: RunEvent) => options.onEvent?.(event);
    const message = (title: string): Message => ({ id: `${run.id}-m${run.messages.length + 1}`, agent: 'claude', phase: 'code', round: 1, title, parts: [], status: 'running', model: 'sonnet', startedAt: Date.now() });
    const say = async (title: string, chunks: string[]) => {
      const m = message(title);
      run.messages.push(m);
      emit({ type: 'message.start', message: structuredClone(m) });
      for (const content of chunks) {
        await sleep(15);
        applyAgentEvent(m.parts, { kind: 'text_delta', content });
        emit({ type: 'message.event', id: m.id, event: { kind: 'text_delta', content } });
      }
      m.status = 'done';
      m.endedAt = Date.now();
      emit({ type: 'message.end', id: m.id, status: 'done', endedAt: m.endedAt, usage: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0, costUsd: 0.02 } });
    };
    const patch = (p: Extract<RunEvent, { type: 'run.update' }>['patch']) => {
      Object.assign(run, p);
      emit({ type: 'run.update', patch: p });
    };
    const prompt = request.prompt ?? '';
    const script = async () => {
      if (prompt.includes('hang')) {
        await say('Claude works', ['working…']);
        await until(() => cancelled, 'cancel', 1000);
        patch({ status: 'cancelled', endedAt: Date.now() });
      } else if (request.mode === 'plan') {
        await say('Claude plans', ['**Plan**\n', '- step one\n', '- step two']);
        const answer = await this.askPlan(patch, say, (resolve) => (decide = resolve), 1);
        if (answer.action === 'approve') await say('Codex implements', ['Implemented the plan']);
        patch({ status: 'done', final: 'ok', endedAt: Date.now(), diff: 'diff --git a/src/a.ts b/src/a.ts\n+one\n-two\n' });
      } else if (prompt.includes('pair')) {
        await say('Codex codes', ['first draft']);
        patch({ pairDecision: { type: 'review-limit', round: 2, extraRounds: 2 } });
        const go = await new Promise<boolean>((resolve) => (pairDecide = resolve));
        patch({ pairDecision: null });
        if (go) await say('Codex codes', ['second draft']);
        patch({ status: 'done', endedAt: Date.now() });
      } else {
        await say('Claude answers', ['Hello ', 'streamed ', 'world']);
        patch({ status: 'done', final: 'Hello streamed world', endedAt: Date.now(), usage: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0, costUsd: 0.02 } });
      }
    };
    const done = script().then(() => run);
    const self = this;
    return {
      id: run.id,
      get run() {
        return run;
      },
      subscribe: () => () => {},
      done,
      cancel: () => {
        cancelled = true;
        self.cancels++;
      },
      answerPlanDecision: async (answer) => {
        self.answers.push(answer);
        if (answer.action === 'approve' && self.approveRefusal) throw new ServiceError('invalid', self.approveRefusal);
        decide?.(answer);
      },
      answerPairDecision: (go) => {
        self.pairAnswers.push(go);
        pairDecide?.(go);
        return true;
      },
    };
  }
}

/* ---- Harness ---- */

const BACKSLASH = String.fromCodePoint(92);
const KEY = { enter: '\r', altEnter: '\u001B\r', shiftEnter: '\u001B[13;2u', tab: '\t', shiftTab: '\u001B[Z', up: '\u001B[A', down: '\u001B[B', left: '\u001B[D', right: '\u001B[C', home: '\u001B[H', end: '\u001B[F', backspace: '\u007F', del: '\u001B[3~', ctrlA: '\u0001', ctrlC: '\u0003', ctrlD: '\u0004', ctrlU: '\u0015', altB: '\u001Bb', ctrlLeft: '\u001B[1;5D' };

function open(service = new FakeService(), history: string[] = []) {
  const app = render(createElement(App, { service: service as unknown as ChatService, cwd: temp, version: 'test', history, skipPreflight: true }));
  const frame = () => app.lastFrame() ?? '';
  const type = async (text: string) => {
    app.stdin.write(text);
    await sleep(25);
  };
  const seeing = (text: string | RegExp, tries?: number) =>
    until(() => (typeof text === 'string' ? frame().includes(text) : text.test(frame())), `"${String(text)}"\n${frame()}`, tries);
  return { app, service, frame, type, seeing };
}

let failed = false;
const step = async (name: string, fn: () => Promise<void>) => {
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

/* ---- Pure pieces ---- */

await step('editor: insert, cursor, words, lines', async () => {
  let s = editor.EMPTY_EDITOR;
  s = editor.insertText(s, 'hello wor');
  s = editor.insertText(s, 'ld');
  assert.equal(s.text, 'hello world');
  s = editor.wordLeft(s);
  assert.equal(s.cursor, 6);
  s = editor.deleteWordBack(s);
  assert.equal(s.text, 'world');
  s = editor.lineEnd(editor.insertText(editor.lineEnd(s), '\nsecond line'));
  assert.equal(editor.lineCount(s), 2);
  const up = editor.moveVertical(s, -1);
  assert.equal(up?.cursor, 5, 'column is kept (clamped) when moving up');
  assert.equal(editor.moveVertical(up!, -1), undefined, 'no line above the first');
  assert.equal(editor.backspace(editor.editorOf('a😀')).text, 'a', 'one backspace removes a whole emoji');
  assert.equal(editor.insertText(editor.EMPTY_EDITOR, 'a\r\nb\rc').text, 'a\nb\nc', 'line breaks are normalised');
  assert.deepEqual(addToHistory(['a', 'b'], 'b'), ['a', 'b'], 'a repeated prompt is not stored twice');
  assert.equal(addToHistory(Array.from({ length: 200 }, (_, i) => `p${i}`), 'new').length, 200, 'history keeps the last 200');
});

await step('markdown-lite and request builder', async () => {
  assert.deepEqual(parseInline('a **b** `c`').map((x) => [x.kind, x.text]), [['plain', 'a '], ['bold', 'b'], ['plain', ' '], ['code', 'c']]);
  const blocks = parseBlocks('# T\n- one\n1. two\n```ts\nlet x = 1;\n```\nend');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'item', 'item', 'code', 'text']);
  const role = { id: 'review', name: 'Review', icon: 'r', description: '', agent: 'codex' as const, model: '', effort: '', permission: 'read' as const, template: '', gradable: true };
  const none = { mode: 'code' as const, role: null, pipelineId: null, overrides: {} };
  assert.deepEqual(buildRequest(none, 'x', '/w'), { prompt: 'x', cwd: '/w', mode: 'code' });
  assert.equal(buildRequest({ ...none, role }, 'x', '/w').roleId, 'review');
  assert.equal(buildRequest({ ...none, role, mode: 'plan' }, 'x', '/w').roleId, undefined, 'plan ignores the role');
  assert.deepEqual(buildRequest({ ...none, overrides: { agent: 'claude', model: 'opus', effort: 'high', permission: 'read' } }, 'x', '/w'), { prompt: 'x', cwd: '/w', mode: 'code', coder: 'claude', permission: 'read', models: { claude: 'opus' }, efforts: { claude: 'high' } });
  assert.deepEqual(buildRequest({ ...none, pipelineId: 'p1' }, 'x', '/w'), { prompt: 'x', cwd: '/w', mode: 'pipeline', pipelineId: 'p1' });
});

/* ---- Composer ---- */

await step('composer: typing, cursor keys, backspace, delete, words', async () => {
  const t = open();
  await t.seeing('Ask anything');
  await t.type('abcd');
  await t.type(KEY.left);
  await t.type(KEY.left);
  await t.type('X');
  await t.seeing('abXcd');
  await t.type(KEY.backspace);
  await t.seeing('abcd');
  await t.type(KEY.home);
  await t.type('>');
  await t.seeing('>abcd');
  await t.type(KEY.end);
  await t.type('!');
  await t.seeing('>abcd!');
  await t.type(KEY.home);
  await t.type(KEY.del);
  await t.seeing('abcd!');
  await t.type(KEY.ctrlU);
  await t.type('one two three');
  await t.type(KEY.altB);
  await t.type('_');
  await t.seeing('one two _three');
});

await step('composer: newline with Alt+Enter, Shift+Enter and trailing backslash', async () => {
  const t = open();
  await t.seeing('Ask anything');
  await t.type('line1');
  await t.type(KEY.altEnter);
  await t.type('line2');
  await t.type(KEY.shiftEnter);
  await t.type('line3');
  await t.type(`line4${BACKSLASH}`);
  await t.type(KEY.enter);
  await t.type('line5');
  const f = t.frame();
  for (const n of ['line1', 'line2', 'line3', 'line4', 'line5']) assert.ok(f.includes(n), `${n} missing:\n${f}`);
  assert.equal(t.service.seen.length, 0, 'nothing was submitted');
  assert.ok(!f.includes(`line4${BACKSLASH}`), 'the backslash was replaced by the line break');
});

await step('composer: paste never submits', async () => {
  const t = open();
  await t.seeing('Ask anything');
  await t.type('\u001B[200~first\nsecond\r\nthird\u001B[201~');
  await t.seeing('third');
  await t.type('tail\rmore');
  await sleep(50);
  assert.equal(t.service.seen.length, 0, 'a paste with line breaks is not a submit');
  assert.ok(t.frame().includes('first') && t.frame().includes('second'));
});

await step('send: streamed reply, run summary, usage, history and continue', async () => {
  const t = open(new FakeService(), []);
  await t.seeing('Ask anything');
  await t.type('say hello');
  await t.type(KEY.enter);
  await t.seeing('Hello streamed world');
  await t.seeing('✓ done');
  await t.seeing('$0.02');
  assert.equal(t.service.seen[0].kind, 'start');
  assert.equal(t.service.seen[0].request.mode, 'code');
  assert.equal(t.service.seen[0].request.prompt, 'say hello');
  assert.ok(t.frame().includes('› say hello'), 'the prompt is echoed in the thread');
  // Same window: the next message continues the run.
  await t.type('and more');
  await t.type(KEY.enter);
  await until(() => t.service.seen.length === 2, 'second request');
  assert.equal(t.service.seen[1].kind, 'continue');
  assert.equal(t.service.seen[1].id, 'run-1');
  await t.seeing('✓ done');
  // Up recalls the previous prompt.
  await sleep(100);
  await t.type(KEY.up);
  await t.seeing('and more');
  await t.type(KEY.up);
  await t.seeing('say hello');
  await t.type(KEY.down);
  await t.seeing('and more');
});

await step('slash menu: filter, choose, run /help, unknown command', async () => {
  const t = open();
  await t.seeing('Ask anything');
  await t.type('/');
  await t.seeing('/help');
  assert.ok(t.frame().includes('/clear') && t.frame().includes('more'), 'the first commands are listed');
  await t.type('mo');
  await t.seeing('/model');
  assert.ok(!t.frame().includes('/exit  '), 'the menu is filtered');
  await t.type(KEY.backspace);
  await t.type(KEY.backspace);
  await t.type('hel');
  await t.type(KEY.enter);
  await t.seeing('Commands:');
  await t.type('/nope');
  await t.type(KEY.enter);
  await t.seeing('Unknown command /nope');
  assert.equal(t.service.seen.length, 0);
});

await step('roles: Tab cycles, Shift+Tab toggles Plan, request follows', async () => {
  const t = open();
  await t.seeing(/Plan\s+Review\s+Code/);
  await t.type(KEY.tab);
  await t.seeing('🧭 Plan');
  await t.type(KEY.tab);
  await t.seeing('🔍 Review');
  await t.type('check it');
  await t.type(KEY.tab);
  assert.ok(t.frame().includes('🔍 Review'), 'Tab does not change the role while there is text');
  await t.type(KEY.enter);
  await until(() => t.service.seen.length === 1, 'request');
  assert.equal(t.service.seen[0].request.roleId, 'review');
  assert.equal(t.service.seen[0].request.mode, 'code');
  await t.seeing('✓ done');
});

await step('mode: Shift+Tab switches to Plan and back', async () => {
  const t = open();
  await t.seeing('CODE');
  await t.type(KEY.shiftTab);
  await t.seeing('PLAN');
  await t.type(KEY.shiftTab);
  await t.seeing('CODE');
});

/* ---- Decisions ---- */

await step('plan decision: approve runs Code', async () => {
  const t = open();
  await t.seeing('Ask anything');
  await t.type(KEY.shiftTab);
  await t.type('design the feature');
  await t.type(KEY.enter);
  await t.seeing('Plan ready');
  assert.equal(t.service.seen[0].request.mode, 'plan');
  assert.ok(t.frame().includes('Approve and run Code') && t.frame().includes('Stop here'));
  await t.type('a');
  await t.seeing('Implemented the plan');
  assert.deepEqual(t.service.answers, [{ action: 'approve' }]);
  await t.seeing('1 file(s) changed');
  await t.seeing('src/a.ts');
});

await step('plan decision: refusal outside Git keeps the plan waiting, refine and stop work', async () => {
  const service = new FakeService();
  service.approveRefusal = 'Code mode needs a Git repository. Run git init.';
  const t = open(service);
  await t.seeing('Ask anything');
  await t.type(KEY.shiftTab);
  await t.type('plan it');
  await t.type(KEY.enter);
  await t.seeing('Plan ready');
  await t.type('a');
  await t.seeing('Code mode needs a Git repository');
  assert.ok(t.frame().includes('Plan ready'), 'still waiting');
  await t.type('r');
  await t.seeing('Feedback for the plan');
  await t.type('add tests');
  await t.type(KEY.enter);
  await until(() => service.answers.some((a) => a.action === 'refine'), 'refine answer');
  assert.deepEqual(service.answers.at(-1), { action: 'refine', feedback: 'add tests' });
  await t.seeing('revision 2');
  await t.type('s');
  await until(() => service.answers.some((a) => a.action === 'stop'), 'stop answer');
  await t.seeing('✓ done');
});

await step('pair decision: continue for more rounds', async () => {
  const t = open();
  await t.seeing('Ask anything');
  await t.type('pair me');
  await t.type(KEY.enter);
  await t.seeing('Not approved after round 2');
  await t.type('y');
  await t.seeing('second draft');
  assert.deepEqual(t.service.pairAnswers, [true]);
});

/* ---- Interrupts ---- */

await step('Ctrl+C: first press stops the run, second press exits', async () => {
  const t = open();
  await t.seeing('Ask anything');
  await t.type('please hang');
  await t.type(KEY.enter);
  await t.seeing('working');
  await t.type(KEY.ctrlC);
  await until(() => t.service.cancels === 1, 'cancel');
  await t.seeing('cancelled');
  assert.ok(t.frame().includes('Stopping the run'));
});

await step('Ctrl+C when idle only arms quitting', async () => {
  const t = open();
  await t.seeing('Ask anything');
  await t.type(KEY.ctrlC);
  await t.seeing('Press Ctrl+C again to exit');
  assert.equal(t.service.cancels, 0);
});

/* ---- startTui on fake terminal streams ---- */

class FakeStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  unshift() {}
  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
  send(text: string) {
    this.data = text;
    this.emit('readable');
    this.emit('data', text);
  }
}
class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 30;
  output = '';
  write = (chunk: string) => {
    this.output += chunk;
    return true;
  };
}

await step('startTui: renders, saves history, exits 0 on Ctrl+D and Ctrl+C twice', async () => {
  const historyFile = path.join(temp, 'saved-history.json');
  for (const quit of [[KEY.ctrlD], [KEY.ctrlC, KEY.ctrlC]]) {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const service = new FakeService();
    const running = startTui({ cwd: temp, service: service as unknown as ChatService, historyFile, skipPreflight: true, stdin: stdin as never, stdout: stdout as never });
    await until(() => stdout.output.includes('Ask anything'), 'first frame', 300);
    assert.ok(stdout.output.includes('AI Duo'), 'header');
    if (quit[0] === KEY.ctrlD) {
      stdin.send('remember me');
      await sleep(30);
      stdin.send(KEY.enter);
      await until(() => service.seen.length === 1, 'request');
      await until(() => stdout.output.includes('✓ done'), 'done');
      await sleep(100);
    }
    for (const key of quit) {
      stdin.send(key);
      await sleep(30);
    }
    assert.equal(await running, 0);
  }
  assert.deepEqual(await loadHistory(historyFile), ['remember me']);
  assert.ok((await readFile(historyFile, 'utf8')).includes('remember me'));
});

await rm(temp, { recursive: true, force: true }).catch(() => {});
if (failed) {
  console.error('TUI smoke test failed');
  process.exit(1);
}
console.log('TUI smoke test passed');
process.exit(0);
