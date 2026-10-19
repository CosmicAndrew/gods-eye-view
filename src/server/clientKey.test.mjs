/**
 * The rate limiters are the spend guard on metered OpenAI and Google calls, and
 * they identify callers by `clientKey`. Upstream deliberately ignores
 * X-Forwarded-For because a client can rotate it to mint unlimited quota - a
 * correct call for a localhost dev proxy, where the socket peer IS the client.
 *
 * Behind Cloud Run that premise is false: every peer is Google's front end, so
 * every caller shares one bucket and one abuser exhausts everyone's budget.
 * These pin a fix that stays safe by counting hops from the right, where only a
 * trusted proxy can append, rather than trusting the header's left edge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clientKeyFrom } from './clientKey.js';

const req = (xff, socket = '10.0.0.1') => ({
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  socket: { remoteAddress: socket },
});

test('with no trusted proxy the socket peer is used, header ignored', () => {
  // Preserves upstream's localhost behaviour exactly.
  assert.equal(clientKeyFrom(req('1.2.3.4', '10.0.0.1'), 0), '10.0.0.1');
});

test('a spoofed header cannot displace the real client behind one proxy', () => {
  // Cloud Run's front end APPENDS what it saw, so the rightmost entry is the
  // only one the attacker could not write.
  assert.equal(clientKeyFrom(req('1.2.3.4, 203.0.113.9'), 1), '203.0.113.9');
});

test('extra spoofed entries on the left are ignored, however many', () => {
  assert.equal(clientKeyFrom(req('9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.9'), 1), '203.0.113.9');
});

test('two trusted hops read one further left', () => {
  // e.g. Cloudflare in front of Cloud Run: last is CF's address, previous is the client.
  assert.equal(clientKeyFrom(req('1.2.3.4, 203.0.113.9, 172.16.0.1'), 2), '203.0.113.9');
});

test('a chain shorter than the trusted hop count falls back to the socket', () => {
  // Fewer entries than expected means the request did not traverse the proxy
  // we were told to trust; trusting the left edge here is the spoof.
  assert.equal(clientKeyFrom(req('1.2.3.4'), 2), '10.0.0.1');
});

test('a missing header falls back to the socket', () => {
  assert.equal(clientKeyFrom(req(undefined), 1), '10.0.0.1');
});

test('whitespace and empty entries do not produce a blank key', () => {
  for (const header of ['  ,  , 203.0.113.9', ' 203.0.113.9 ', ',,,']) {
    const key = clientKeyFrom(req(header), 1);
    assert.ok(key && key.trim(), `blank key from ${JSON.stringify(header)}`);
  }
});

test('an array-valued header is handled, not stringified into nonsense', () => {
  // Node exposes a repeated header as an array.
  assert.equal(clientKeyFrom({ headers: { 'x-forwarded-for': ['1.2.3.4', '203.0.113.9'] }, socket: { remoteAddress: '10.0.0.1' } }, 1), '203.0.113.9');
});

test('an absent socket never yields undefined', () => {
  assert.equal(clientKeyFrom({ headers: {} }, 0), 'local');
});

test('hop counts are clamped, so a bad env value cannot trust the left edge', () => {
  for (const hops of [-1, Number.NaN, 99, 'abc']) {
    const key = clientKeyFrom(req('1.2.3.4, 203.0.113.9'), hops);
    assert.notEqual(key, '1.2.3.4', `spoofable left edge trusted with hops=${hops}`);
  }
});
