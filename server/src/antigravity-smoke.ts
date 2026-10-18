import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agyArgs, agyDenials, agyError, agyFinalText, agyMode, initialAgyState, onAgyEvent, type AgyState } from './agents/antigravity.ts';
import { antigravityAuthStatus } from './agents/billing.ts';
import type { AgentEvent } from './agents/types.ts';

// Events as recorded from `agy --input-format stream-json --output-format stream-json -p=` (agy 1.3.2).
const feed = (lines: unknown[], state: AgyState = initialAgyState()) => {
  const events: AgentEvent[] = [];
  for (const ev of lines) {
    const out = onAgyEvent(ev, state);
    state = out.state;
    events.push(...out.events);
  }
  return { state, events };
};

const ok = feed([
  { event: 'init', init: { conversation_id: 'c-1', cwd: '/x', tools: [] } },
  { event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 0, state: 'DONE', step_type: 'user_input' } },
  { event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'pong\n', usage: { input_tokens: 5 } } },
  { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: 'a.txt' } } } },
  { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file' } },
  { event: 'result', result: { conversation_id: 'c-1', status: 'SUCCESS', response: 'pong\n', usage: { input_tokens: 11637, output_tokens: 55, thinking_tokens: 54, cache_read_tokens: 100, total_tokens: 11692 } } },
]);
assert.equal(ok.state.sessionId, 'c-1');
assert.deepEqual(ok.events.map((e) => e.kind), ['text_delta', 'tool'], 'a tool shows once, when it starts');
assert.match(ok.events[1].content, /write_to_file .*a\.txt/);
assert.deepEqual(ok.state.usage, { inputTokens: 11637, outputTokens: 55, cachedInputTokens: 100 }, 'output already counts thinking tokens');
assert.equal(agyFinalText(ok.state), 'pong');
assert.equal(agyError(ok.state, 0, ''), undefined);

// Without a closing response the streamed text is used.
const streamed = feed([{ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'hello ' } }, { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'world' } }, { event: 'result', result: { status: 'SUCCESS' } }]);
assert.equal(agyFinalText(streamed.state), 'hello world');

// The conversation id: top level on init (documented), nested in init.init (older), and result wins over both.
assert.equal(feed([{ event: 'init', conversation_id: 'top' }]).state.sessionId, 'top');
assert.equal(feed([{ event: 'init', init: { conversation_id: 'nested' } }]).state.sessionId, 'nested');
assert.equal(feed([{ event: 'init', conversation_id: 'top', init: { conversation_id: 'nested' } }]).state.sessionId, 'top', 'the documented place first');
assert.equal(feed([{ event: 'init', conversation_id: 'top' }, { event: 'result', result: { status: 'SUCCESS', conversation_id: 'final' } }]).state.sessionId, 'final');
assert.equal(feed([{ event: 'init', conversation_id: '' }, { event: 'init', conversation_id: 7 }], initialAgyState('c-0')).state.sessionId, 'c-0', 'an empty or non-string id is ignored');

// Headless mode refuses tools softly: stderr is the main source, denied_actions only adds to it.
const denied = feed([{ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }, { action: 'command' }] } }]);
assert.match(agyFinalText(denied.state), /từ chối công cụ cần duyệt: command\./);
const stderrDenied = agyDenials('loading settings\nTool run_command was denied: requires approval\r\nTool run_command was denied: requires approval\n');
assert.deepEqual(stderrDenied, ['Tool run_command was denied: requires approval']);
assert.match(agyFinalText(feed([{ event: 'result', result: { status: 'SUCCESS', response: '' } }]).state, stderrDenied), /run_command was denied/);
assert.doesNotMatch(agyFinalText(denied.state, stderrDenied), /dangerously|skip-permissions/, 'never suggests switching permission checks off');
assert.equal(agyFinalText(ok.state, stderrDenied), 'pong', 'a reply is kept as it is');
assert.deepEqual(agyDenials('all good\n'), []);

// A failed result carries agy's own message; a non-zero exit fails even after SUCCESS; no result at all fails.
const failed = feed([{ event: 'result', result: { status: 'ERROR', error: 'failed to decode stream input' } }]);
assert.equal(agyError(failed.state, 0, ''), 'failed to decode stream input');
assert.match(agyError(initialAgyState(), 3, 'boom') ?? '', /exited with code 3: boom/);
assert.match(agyError(ok.state, 2, 'late crash') ?? '', /exited with code 2 after its result: late crash/);
assert.match(agyError(initialAgyState(), 0, '') ?? '', /không gửi kết quả/, 'a stream that ends without result is an error');
assert.match(agyError(initialAgyState(), 1, "error: unknown flag: --mode", 'plan') ?? '', /không nhận chế độ headless.*--mode plan/, 'an agy without --mode is reported, never run with less protection');
assert.match(agyError(initialAgyState(), 1, 'Error: not logged in') ?? '', /đăng nhập lại bằng tài khoản Google/, 'a real auth failure becomes login guidance');
assert.match(agyError(feed([{ event: 'result', result: { status: 'ERROR', error: '401 Unauthorized' } }]).state, 0, '') ?? '', /đăng nhập lại/);
assert.equal(agyError(ok.state, 0, 'Error: not logged in'), undefined, 'a successful turn is not failed by stderr noise');
assert.equal(feed([{ event: 'something_new' }, { event: 'step_update' }, null]).events.length, 0, 'unknown events are ignored');

// The mode is always passed: plan for read turns, accept-edits for edit turns.
assert.equal(agyMode({ role: 'thinker' }), 'plan');
assert.equal(agyMode({ role: 'reviewer' }), 'plan');
assert.equal(agyMode({ role: 'coder' }), 'accept-edits');
assert.equal(agyMode({ role: 'coder', permission: 'read' }), 'plan');
assert.equal(agyMode({ role: 'thinker', permission: 'edit' }), 'accept-edits');
assert.deepEqual(agyArgs({ role: 'thinker', sessionId: 'c-1', model: 'm', effort: 'high' }, ['--verbose']), [
  '--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '--conversation', 'c-1', '--model', 'm', '--effort', 'high', '--verbose', '-p=',
]);

// Resuming keeps the conversation id when the CLI does not repeat it.
assert.equal(feed([{ event: 'result', result: { status: 'SUCCESS', response: 'x' } }], initialAgyState('c-9')).state.sessionId, 'c-9');

// agy cannot report its login: the folder it creates on first sign-in is no proof the login is still valid.
const home = await mkdtemp(path.join(tmpdir(), 'ai-duo-agy-'));
try {
  const never = await antigravityAuthStatus(home);
  assert.equal(never.state, 'unknown');
  assert.match('error' in never ? never.error : '', /chưa xác minh.*chưa thấy agy từng chạy/);
  await writeFile(path.join(home, 'installation_id'), 'x');
  const once = await antigravityAuthStatus(home);
  assert.equal(once.state, 'unknown', 'installation_id is not a verified login');
  assert.match('error' in once ? once.error : '', /chưa xác minh/);
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log('PASS antigravity: stream-json events, conversation ids, modes, usage, denied actions, errors, login detection');
