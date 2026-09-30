import assert from 'node:assert/strict';
import { stopRunsAndQuit } from './shutdown.mjs';

let quits = 0;
let stopped = false;
await stopRunsAndQuit(async () => { stopped = true; }, () => { assert.ok(stopped); quits++; });
const errors = [];
const failure = new Error('shutdown failed');
const reportError = (_message, err) => errors.push(err);
await stopRunsAndQuit(() => Promise.reject(failure), () => { quits++; }, { reportError });
await stopRunsAndQuit(() => { throw failure; }, () => { quits++; }, { reportError });
assert.deepEqual(errors, [failure, failure]);
let rejectLate;
await stopRunsAndQuit(() => new Promise((_resolve, reject) => { rejectLate = reject; }), () => { quits++; }, { timeoutMs: 10 });
rejectLate(failure); // The race must also handle rejection after the timeout has won.
await new Promise((resolve) => setImmediate(resolve));
assert.equal(quits, 4);
console.log('PASS desktop shutdown: saved runs, rejection, synchronous failure and timeout');
