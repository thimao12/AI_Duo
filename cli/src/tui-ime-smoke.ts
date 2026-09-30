/**
 * IME smoke test: Vietnamese Telex / Unikey input reaches the composer and TextField intact.
 *   pnpm --filter ai-duo-cli exec tsx src/tui-ime-smoke.ts
 *
 * Unikey (backspace mode) and Windows Telex re-compose text by sending a burst of Backspace bytes
 * followed by the new letters, sometimes as separate stdin chunks and sometimes in one ("\x7f\x7fủa").
 * The result must not depend on how the bytes are chunked, nor on NFC vs NFD.
 */
import assert from 'node:assert/strict';
import { createElement as h, useState, type ReactElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { Composer } from './tui/Composer.tsx';
import * as editor from './tui/editor.ts';
import TextField, { editText } from './tui/widgets/TextField.tsx';

process.env.NO_COLOR = '1';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const BS = '\u007F';
const KEY = { enter: '\r', left: '\u001B[D', right: '\u001B[C', del: '\u001B[3~', home: '\u001B[H', end: '\u001B[F' };
const PASTE_START = '\u001B[200~';
const PASTE_END = '\u001B[201~';

interface Script {
  target: string;
  chunks: string[];
}

/** What Unikey sends for each word: typed letters, then Backspace bursts with the re-composed tail. */
const SCRIPTS: Script[] = [
  { target: 'của', chunks: ['c', 'u', 'a', `${BS}${BS}ủa`] },
  { target: 'usage của', chunks: [...'usage ', 'c', 'u', 'a', `${BS}${BS}ủa`] },
  { target: 'được', chunks: ['d', `${BS}đ`, 'u', 'o', `${BS}${BS}ươ`, 'c', `${BS}${BS}${BS}ược`] },
  { target: 'tiếng Việt', chunks: ['t', 'i', 'e', `${BS}ê`, 'n', 'g', `${BS}${BS}${BS}ếng`, ' ', 'V', 'i', 'e', `${BS}ê`, 't', `${BS}${BS}ệt`] },
  { target: 'Nguyễn', chunks: ['N', 'g', 'u', 'y', 'e', `${BS}ê`, 'n', `${BS}${BS}ễn`] },
  { target: 'hoà', chunks: ['h', 'o', 'a', `${BS}à`] },
];

/** The same keystrokes with every text piece decomposed (u + horn + hook), as some IMEs send it. */
const decomposed = (chunks: string[]) => chunks.map((c) => [...c].map((ch) => (ch === BS ? ch : ch.normalize('NFD'))).join(''));

interface Delivery {
  name: string;
  send(write: (data: string) => void, chunks: string[]): Promise<void>;
}

const DELIVERIES: Delivery[] = [
  {
    name: 'separate chunks',
    async send(write, chunks) {
      for (const chunk of chunks) {
        write(chunk);
        await sleep(12);
      }
    },
  },
  {
    name: 'one chunk per word',
    async send(write, chunks) {
      write(chunks.join(''));
      await sleep(40);
    },
  },
  {
    name: 'burst without delay',
    async send(write, chunks) {
      for (const chunk of chunks) write(chunk);
      await sleep(40);
    },
  },
];

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

function mountComposer() {
  const drafts: string[] = [];
  const submitted: string[] = [];
  const app = render(
    h(Composer, {
      onSubmit: (text: string) => {
        submitted.push(text);
        return null;
      },
      onDraft: (text: string) => {
        drafts.push(text);
      },
    }),
  );
  return { app, submitted, text: () => drafts.at(-1) ?? '' };
}

function Field(props: Readonly<{ log: string[] }>): ReactElement {
  const [value, setValue] = useState('');
  return h(TextField, {
    value,
    onChange: (v: string) => {
      props.log.push(v);
      setValue(v);
    },
  });
}

/* ---- Pure editor ---- */

await step('editor: NFC on insert, combining marks join, cursor and backspace are per visible character', async () => {
  const nfd = 'cửa'; // c + u + horn + hook + a
  const s = editor.insertText(editor.EMPTY_EDITOR, nfd);
  assert.equal(s.text, 'cửa', 'decomposed input is stored as NFC');
  assert.equal(editor.backspace(s).text, 'cử');
  // A tone arriving as its own chunk joins the letter before the cursor.
  let split = editor.insertText(editor.EMPTY_EDITOR, 'cu');
  split = editor.insertText(split, '̛');
  split = editor.insertText(split, '̉');
  assert.equal(split.text, 'cử');
  assert.equal(split.cursor, 2);
  // Text that is already decomposed (loaded from elsewhere): one visible character per step.
  const raw = { text: 'c' + 'ử' + 'a', cursor: 5 };
  assert.equal(editor.moveLeft(raw).cursor, 4);
  assert.equal(editor.moveLeft(editor.moveLeft(raw)).cursor, 1);
  assert.equal(editor.moveRight({ text: raw.text, cursor: 1 }).cursor, 4);
  assert.equal(editor.backspace({ text: raw.text, cursor: 4 }).text, 'ca');
  assert.equal(editor.deleteForward({ text: raw.text, cursor: 1 }).text, 'ca');
  assert.equal(editor.backspace(editor.editorOf('a😀')).text, 'a');
});

/* ---- Composer ---- */

for (const delivery of DELIVERIES) {
  for (const decompose of [false, true]) {
    await step(`composer: Telex words via ${delivery.name}${decompose ? ' (NFD)' : ''}`, async () => {
      for (const script of SCRIPTS) {
        const t = mountComposer();
        await sleep(30);
        await delivery.send((d) => t.app.stdin.write(d), decompose ? decomposed(script.chunks) : script.chunks);
        assert.equal(t.text().normalize('NFC'), script.target, `${script.target} -> ${JSON.stringify(t.text())}`);
        assert.equal(t.text(), t.text().normalize('NFC'), 'stored as NFC');
        assert.deepEqual(t.submitted, []);
        t.app.unmount();
      }
    });
  }
}

await step('composer: plain keys still edit; multi-line paste does not submit', async () => {
  const t = mountComposer();
  await sleep(30);
  const type = async (d: string) => {
    t.app.stdin.write(d);
    await sleep(25);
  };
  await type('abcd');
  await type(KEY.left);
  await type(KEY.left);
  await type('X');
  assert.equal(t.text(), 'abXcd');
  await type(BS);
  assert.equal(t.text(), 'abcd');
  await type(KEY.home);
  await type(KEY.del);
  assert.equal(t.text(), 'bcd');
  await type(KEY.end);
  await type(`${PASTE_START}line one\nline two\r\nline three${PASTE_END}`);
  assert.equal(t.text(), 'bcdline one\nline two\nline three');
  assert.deepEqual(t.submitted, []);
  await type(KEY.enter);
  assert.equal(t.submitted.length, 1);
  assert.equal(t.text(), '');
});

/* ---- TextField ---- */

await step('textfield: Telex burst and NFD chunks', async () => {
  for (const delivery of DELIVERIES) {
    for (const script of SCRIPTS) {
      const log: string[] = [];
      const app = render(h(Field, { log }));
      await sleep(30);
      await delivery.send((d) => app.stdin.write(d), decomposed(script.chunks));
      assert.equal(log.at(-1), script.target, `${delivery.name}: ${script.target} -> ${JSON.stringify(log.at(-1))}`);
      app.unmount();
    }
  }
});

await step('textfield: Backspace removes a whole Vietnamese letter', async () => {
  const state = { value: 'cửa', cursor: 2 };
  const plain = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: true, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false };
  assert.equal(editText(state, '', plain).value, 'ca');
  assert.equal(editText({ value: 'cửa', cursor: 4 }, '', plain).value, 'ca');
});

if (failed) process.exit(1);
console.log('IME smoke test passed');
