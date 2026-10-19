/**
 * The deployed app brokers metered Google and OpenAI keys, so a public URL
 * must not be reachable without credentials. These pin the gate's contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { basicAuthGate } from '../../server/standalone/basic-auth-gate.js';

/** Install the plugin on a fake server and return the registered handlers. */
function install(plugin, hook = 'configureServer') {
  const handlers = [];
  plugin[hook]?.({ middlewares: { use: (...args) => handlers.push(args[args.length - 1]) } });
  return handlers;
}

/** Drive one handler and capture what it did to the response. */
async function run(handler, { auth } = {}) {
  const req = { headers: auth ? { authorization: auth } : {}, url: '/', method: 'GET' };
  const res = {
    statusCode: 200,
    headers: {},
    ended: false,
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(chunk) { this.ended = true; this.body = chunk ?? ''; },
  };
  let nextCalled = false;
  await handler(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

const creds = { user: 'andrew', password: 'correct-horse' };
const header = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

test('gate stays out of the way when no password is configured', () => {
  assert.equal(install(basicAuthGate({})).length, 0);
  assert.equal(install(basicAuthGate({ user: 'andrew' })).length, 0, 'a user without a password must not half-arm the gate');
});

test('a request with no credentials is challenged, not served', async () => {
  const [handler] = install(basicAuthGate(creds));
  const { res, nextCalled } = await run(handler);

  assert.equal(nextCalled, false, 'unauthenticated request must not reach the app');
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['www-authenticate'] ?? '', /^Basic realm=/);
});

test('wrong password is rejected', async () => {
  const [handler] = install(basicAuthGate(creds));
  const { res, nextCalled } = await run(handler, { auth: header('andrew', 'wrong') });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('wrong username is rejected even with the right password', async () => {
  const [handler] = install(basicAuthGate(creds));
  const { nextCalled } = await run(handler, { auth: header('mallory', 'correct-horse') });

  assert.equal(nextCalled, false);
});

test('correct credentials pass through untouched', async () => {
  const [handler] = install(basicAuthGate(creds));
  const { res, nextCalled } = await run(handler, { auth: header('andrew', 'correct-horse') });

  assert.equal(nextCalled, true);
  assert.equal(res.ended, false, 'the gate must not write to a response it is letting through');
});

test('a malformed Authorization header is rejected, not crashed on', async () => {
  const [handler] = install(basicAuthGate(creds));
  for (const auth of ['Basic', 'Basic !!!not-base64!!!', 'Bearer token', 'Basic ' + Buffer.from('nocolon').toString('base64')]) {
    const { res, nextCalled } = await run(handler, { auth });
    assert.equal(nextCalled, false, `must reject: ${auth}`);
    assert.equal(res.statusCode, 401, `must 401: ${auth}`);
  }
});

test('the gate guards the preview server too, not just dev', () => {
  assert.equal(install(basicAuthGate(creds), 'configurePreviewServer').length, 1);
});
