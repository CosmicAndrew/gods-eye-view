/**
 * Cloud Run runs one process per instance and restarts it on exit, so a single
 * unhandled rejection anywhere in 19 proxy routes takes the whole app down and
 * the restart policy hides why. And SIGTERM arrives before every scale-down and
 * every deploy, so ignoring it drops in-flight requests on a routine release.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installProcessGuards } from './processGuards.js';

/** Stand-in for `process` that records handlers instead of installing them. */
function fakeProcess() {
  const handlers = new Map();
  return {
    handlers,
    listenerCount: (event) => (handlers.has(event) ? 1 : 0),
    on(event, fn) { handlers.set(event, fn); return this; },
    emit(event, ...args) { return handlers.get(event)?.(...args); },
    exitCode: undefined,
  };
}

test('an unhandled rejection is logged, not fatal', () => {
  const proc = fakeProcess();
  const logged = [];
  installProcessGuards({ proc, log: (m) => logged.push(m) });

  proc.emit('unhandledRejection', new Error('upstream exploded'));

  assert.equal(proc.exitCode, undefined, 'the process must survive');
  assert.ok(logged.some((m) => /upstream exploded/.test(m)), `not logged: ${JSON.stringify(logged)}`);
});

test('an uncaught exception is logged too', () => {
  const proc = fakeProcess();
  const logged = [];
  installProcessGuards({ proc, log: (m) => logged.push(m) });

  proc.emit('uncaughtException', new Error('boom'));

  assert.ok(logged.some((m) => /boom/.test(m)));
});

test('SIGTERM runs the shutdown hook before exiting', async () => {
  const proc = fakeProcess();
  const order = [];
  installProcessGuards({ proc, log: () => {}, onShutdown: async () => { order.push('shutdown'); } });

  await proc.emit('SIGTERM');

  assert.deepEqual(order, ['shutdown']);
  assert.equal(proc.exitCode, 0, 'a requested shutdown is not a failure');
});

test('a shutdown hook that throws still lets the process exit', async () => {
  const proc = fakeProcess();
  installProcessGuards({ proc, log: () => {}, onShutdown: async () => { throw new Error('cleanup failed'); } });

  await proc.emit('SIGTERM');

  assert.equal(proc.exitCode, 0, 'a failed cleanup must not wedge the shutdown');
});

test('guards install only once, so a restarted dev server does not stack handlers', () => {
  const proc = fakeProcess();
  installProcessGuards({ proc, log: () => {} });
  const first = proc.handlers.get('unhandledRejection');
  installProcessGuards({ proc, log: () => {} });

  assert.equal(proc.handlers.get('unhandledRejection'), first, 'handler was replaced/stacked');
});

test('every signal Cloud Run and local dev actually send is covered', () => {
  const proc = fakeProcess();
  installProcessGuards({ proc, log: () => {} });

  for (const event of ['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT']) {
    assert.ok(proc.handlers.has(event), `missing handler: ${event}`);
  }
});
