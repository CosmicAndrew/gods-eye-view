/**
 * Defects found by an independent review of the gate and the rate-limit key.
 * Each test names the hole it closes so a future edit that reopens one fails
 * with the reason attached.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { basicAuthGate, requiresGate } from '../../server/standalone/basic-auth-gate.js';
import { clientKeyFrom } from './clientKey.js';

const header = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

function install(plugin, hook = 'configurePreviewServer', server = { middlewares: { use() {} } }) {
  const handlers = [];
  plugin[hook]?.({ ...server, middlewares: { use: (...a) => handlers.push(a[a.length - 1]) } });
  return handlers;
}

async function run(handler, auth) {
  const req = { headers: auth ? { authorization: auth } : {}, url: '/', method: 'GET' };
  const res = {
    statusCode: 200, headers: {}, ended: false, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(c) { this.ended = true; this.body = c ?? ''; },
  };
  let next = false;
  await handler(req, res, () => { next = true; });
  return { res, next };
}

// D1: `required` was derived from env.HOST, which `vite preview --host 0.0.0.0`
// never sets - a public bind with no credentials served everything.
test('a public bind requires the gate however the host was supplied', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.50', true]) {
    assert.equal(requiresGate(host), true, `should require a gate: ${String(host)}`);
  }
});

test('loopback and an unset host do not require the gate', () => {
  for (const host of ['localhost', '127.0.0.1', '::1', undefined, '', false]) {
    assert.equal(requiresGate(host), false, `should not require a gate: ${String(host)}`);
  }
});

test('the gate reads the resolved host, not just the environment', async () => {
  // Vite exposes the host it actually bound, including a --host CLI flag.
  const handlers = install(basicAuthGate({}), 'configurePreviewServer', {
    config: { preview: { host: '0.0.0.0' } },
  });
  assert.equal(handlers.length, 1, 'a public bind with no credentials must install a refusal');
  const { res, next } = await run(handlers[0]);
  assert.equal(next, false);
  assert.equal(res.statusCode, 503);
});

// D6: RFC 7235 makes the auth-scheme case-insensitive; rejecting `basic` locks
// out a legitimate client rather than an attacker.
test('the Basic scheme is matched case-insensitively', async () => {
  const [handler] = install(basicAuthGate({ user: 'a', password: 'b' }));
  for (const scheme of ['Basic', 'basic', 'BASIC', 'BaSiC']) {
    const auth = `${scheme} ${Buffer.from('a:b').toString('base64')}`;
    const { next } = await run(handler, auth);
    assert.equal(next, true, `rejected valid credentials under scheme "${scheme}"`);
  }
});

test('a non-Basic scheme is still rejected', async () => {
  const [handler] = install(basicAuthGate({ user: 'a', password: 'b' }));
  const { next } = await run(handler, `Bearer ${Buffer.from('a:b').toString('base64')}`);
  assert.equal(next, false);
});

// D2: the comparison returned early on a length mismatch, leaking the exact
// byte length of both the username and the password.
test('credentials of any length are still judged correctly', async () => {
  const [handler] = install(basicAuthGate({ user: 'andrew', password: 'correct-horse' }));
  for (const [u, p] of [['a', 'b'], ['andrew', 'x'], ['', ''], ['andrew', 'correct-horse-longer'], ['a'.repeat(500), 'b'.repeat(500)]]) {
    const { next } = await run(handler, header(u, p));
    assert.equal(next, false, `accepted wrong credentials: ${u.slice(0, 10)}`);
  }
  const { next } = await run(handler, header('andrew', 'correct-horse'));
  assert.equal(next, true, 'rejected the correct credentials');
});

// D5: unequal spellings of one address became separate rate-limit buckets.
test('equivalent address spellings collapse to one rate-limit identity', () => {
  const key = (xff) => clientKeyFrom({ headers: { 'x-forwarded-for': xff }, socket: {} }, 1);
  const canonical = key('203.0.113.9');
  assert.equal(key('::ffff:203.0.113.9'), canonical, 'IPv4-mapped IPv6 must not be a second bucket');
  assert.equal(key('203.0.113.9:443'), canonical, 'a port must not mint a second bucket');
  assert.equal(key('  203.0.113.9  '), canonical);
});

test('an address-shaped check does not mangle real IPv6', () => {
  const key = (xff) => clientKeyFrom({ headers: { 'x-forwarded-for': xff }, socket: {} }, 1);
  assert.equal(key('2001:db8::1'), '2001:db8::1');
});
