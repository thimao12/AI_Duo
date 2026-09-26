import assert from 'node:assert/strict';
import { codexError, initialCodexJsonState, onJson as onCodexJson } from './agents/codex.ts';
import { initialClaudeJsonState, onJson as onClaudeJson } from './agents/claude.ts';
import { JsonlDecoder, spawnJsonl } from './agents/process.ts';
import { classifyError, validateTurnOutput } from './run.ts';

const json: unknown[] = [];
const raw: string[] = [];
const decoder = new JsonlDecoder((value) => json.push(value), (line) => raw.push(line));
decoder.push('{"first":');
decoder.push('1}\r');
decoder.push('\n{"last":');
decoder.push('2}');
decoder.end();
assert.deepEqual(json, [{ first: 1 }, { last: 2 }]);
assert.deepEqual(raw, []);

const boundedDecoder = new JsonlDecoder(() => {}, () => {}, 3);
assert.throws(() => boundedDecoder.push('1234'), /Dòng JSONL vượt 64 MB – output bất thường/);

let codexState = initialCodexJsonState();
const errorEvent = onCodexJson({ type: 'error', message: 'transient warning' }, codexState);
codexState = errorEvent.state;
assert.deepEqual(errorEvent.events, [{ kind: 'error', content: 'transient warning' }]);
codexState = onCodexJson({ type: 'turn.completed' }, codexState).state;
assert.equal(codexError(codexState, 0, ''), undefined);

let failedCodexState = initialCodexJsonState();
failedCodexState = onCodexJson({ type: 'error', message: 'request failed' }, failedCodexState).state;
assert.equal(codexError(failedCodexState, 1, ''), 'request failed');
failedCodexState = onCodexJson({ type: 'turn.failed', error: { message: 'turn failed' } }, failedCodexState).state;
assert.equal(codexError(failedCodexState, 0, ''), 'turn failed');

assert.throws(() => validateTurnOutput('claude', 'thinker', ' \n\t'), /Claude trả về câu trả lời rỗng/);
assert.throws(() => validateTurnOutput('codex', 'reviewer', ''), /Codex trả về câu trả lời rỗng/);
validateTurnOutput('codex', 'coder', '');

const hints = [
  ['spawn codex ENOENT', 'Không tìm thấy CLI, đặt CLAUDE_BIN/CODEX_BIN'],
  ['rate limit reached: 429', 'Hết quota, thử lại sau hoặc đổi model'],
  ['Unauthorized: not logged in (401)', 'Chạy `claude` / `codex login`'],
  ['Claude timed out after 30s', 'Tăng Giới hạn mỗi lượt'],
] as const;
for (const [message, hint] of hints) assert.equal(classifyError(message), `${message}\n${hint}`);
assert.equal(classifyError('other failure'), 'other failure');
// Incidental numbers / tool-level ENOENT inside stderr must not produce misleading hints.
assert.equal(classifyError('exit 1: wrote 4012 bytes, id 14290'), 'exit 1: wrote 4012 bytes, id 14290');
assert.equal(classifyError("tool error: ENOENT: no such file, open 'x.txt'"), "tool error: ENOENT: no such file, open 'x.txt'");

const quiet = onClaudeJson({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, initialClaudeJsonState());
assert.deepEqual(quiet.events, [], "'allowed' rate-limit events should not clutter the message");

const allowed = onClaudeJson(
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day' } },
  initialClaudeJsonState(),
);
assert.equal(allowed.state.errorText, undefined);
assert.equal(allowed.events[0]?.kind, 'raw');
assert.match(allowed.events[0]?.content ?? '', /Claude quota \(allowed_warning\).*7 ngày/);
const rejected = onClaudeJson(
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day' } },
  initialClaudeJsonState(),
);
assert.match(rejected.state.errorText ?? '', /rejected/);
const resultError = onClaudeJson({ type: 'result', is_error: true, result: 'failed result' }, initialClaudeJsonState());
assert.equal(resultError.state.errorText, 'failed result');

await assert.rejects(
  spawnJsonl(process.execPath, ['-e', "process.stdout.write('x'.repeat(64 * 1024 * 1024 + 1)); setInterval(() => {}, 1000)"], {
    cwd: process.cwd(),
    stdin: '',
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    onJson: () => {},
    onRawLine: () => {},
  }),
  /Dòng JSONL vượt 64 MB – output bất thường/,
);

console.log('PASS agent parser smoke');
