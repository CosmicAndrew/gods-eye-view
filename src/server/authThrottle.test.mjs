/**
 * The gate answers every wrong password with an immediate 401 and keeps no
 * count, so guessing is unlimited - verified externally at 1,000 consecutive
 * attempts, none throttled. The spend rate limiters cannot help: the gate runs
 * ahead of them, so a guess never reaches one.
 *
 * The password is long enough that guessing it is not the real risk; the cost
 * is. Every attempt is a billable Cloud Run request, and an unthrottled gate
 * turns the only control on the app into an unmetered one.
 *
 * The counter itself must not become the next problem: an attacker rotating
 * source addresses would grow an unbounded map, so eviction is part of the
 * contract, not an optimisation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAuthThrottle } from './authThrottle.js';

const FAILURES_ALLOWED = 5;

function throttle(overrides = {}) {
  let now = 1_000_000;
  const t = createAuthThrottle({
    maxFailures: FAILURES_ALLOWED,
    windowMs: 60_000,
    cooldownMs: 120_000,
    maxTracked: 4,
    now: () => now,
    ...overrides,
  });
  return { t, advance: (ms) => { now += ms; }, at: () => now };
}

test('attempts below the limit are not blocked', () => {
  const { t } = throttle();
  for (let i = 0; i < FAILURES_ALLOWED; i++) {
    assert.equal(t.blockedFor('1.2.3.4'), 0, `blocked early at attempt ${i + 1}`);
    t.recordFailure('1.2.3.4');
  }
});

test('the attempt after the limit is blocked, with a retry delay', () => {
  const { t } = throttle();
  for (let i = 0; i < FAILURES_ALLOWED; i++) t.recordFailure('1.2.3.4');

  const wait = t.blockedFor('1.2.3.4');
  assert.ok(wait > 0, 'expected a positive retry-after');
  assert.ok(wait <= 120, `retry-after should be in seconds, got ${wait}`);
});

test('one client being blocked does not block another', () => {
  const { t } = throttle();
  for (let i = 0; i < FAILURES_ALLOWED; i++) t.recordFailure('1.2.3.4');

  assert.ok(t.blockedFor('1.2.3.4') > 0);
  assert.equal(t.blockedFor('5.6.7.8'), 0, 'an unrelated caller must not be punished');
});

test('a correct password clears that client immediately', () => {
  const { t } = throttle();
  for (let i = 0; i < FAILURES_ALLOWED - 1; i++) t.recordFailure('1.2.3.4');
  t.recordSuccess('1.2.3.4');

  for (let i = 0; i < FAILURES_ALLOWED; i++) {
    assert.equal(t.blockedFor('1.2.3.4'), 0, 'the counter did not reset on success');
    t.recordFailure('1.2.3.4');
  }
});

test('the block lifts once the cooldown elapses', () => {
  const { t, advance } = throttle();
  for (let i = 0; i < FAILURES_ALLOWED; i++) t.recordFailure('1.2.3.4');
  assert.ok(t.blockedFor('1.2.3.4') > 0);

  advance(120_001);
  assert.equal(t.blockedFor('1.2.3.4'), 0, 'a legitimate user must not be locked out permanently');
});

test('stale failures age out of the window instead of accumulating forever', () => {
  const { t, advance } = throttle();
  for (let i = 0; i < FAILURES_ALLOWED - 1; i++) t.recordFailure('1.2.3.4');
  advance(60_001); // the whole window passes
  t.recordFailure('1.2.3.4');

  assert.equal(t.blockedFor('1.2.3.4'), 0, 'expired failures should not count toward the limit');
});

test('the tracking map is bounded, so rotating addresses cannot exhaust memory', () => {
  const { t } = throttle();
  for (let i = 0; i < 50; i++) t.recordFailure(`10.0.0.${i}`);

  assert.ok(t.size() <= 4, `tracked ${t.size()} clients, expected at most 4`);
});

test('eviction keeps the most recent offender, not the oldest', () => {
  const { t } = throttle();
  for (let i = 0; i < 20; i++) t.recordFailure(`10.0.0.${i}`);
  for (let i = 0; i < FAILURES_ALLOWED; i++) t.recordFailure('10.0.0.99');

  assert.ok(t.blockedFor('10.0.0.99') > 0, 'the active attacker was evicted');
});
