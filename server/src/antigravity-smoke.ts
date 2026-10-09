import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agyError, agyFinalText, initialAgyState, onAgyEvent, type AgyState } from './agents/antigravity.ts';
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

// Headless mode denied a tool: no output, and the reason says how to allow it.
const denied = feed([{ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }, { action: 'command' }] } }]);
assert.match(agyFinalText(denied.state), /từ chối quyền: command\./);

// A failed result carries agy's own message; no result at all falls back to the exit code.
const failed = feed([{ event: 'result', result: { status: 'ERROR', error: 'failed to decode stream input' } }]);
assert.equal(agyError(failed.state, 0, ''), 'failed to decode stream input');
assert.match(agyError(initialAgyState(), 3, 'boom') ?? '', /exited with code 3: boom/);
assert.equal(feed([{ event: 'something_new' }, { event: 'step_update' }]).events.length, 0, 'unknown events are ignored');

// Resuming keeps the conversation id when the CLI does not repeat it.
assert.equal(feed([{ event: 'result', result: { status: 'SUCCESS', response: 'x' } }], initialAgyState('c-9')).state.sessionId, 'c-9');

// Login is recognised by the folder agy creates when it first signs in.
const home = await mkdtemp(path.join(tmpdir(), 'ai-duo-agy-'));
try {
  assert.equal((await antigravityAuthStatus(home)).state, 'unknown');
  await writeFile(path.join(home, 'installation_id'), 'x');
  assert.equal((await antigravityAuthStatus(home)).state, 'ok');
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log('PASS antigravity: stream-json events, usage, denied actions, errors, login detection');
