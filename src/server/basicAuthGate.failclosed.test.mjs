/**
 * The gate uninstalls itself when no credentials are configured, so localhost
 * runs unchanged. On a public deployment that same behaviour is a silent
 * failure open: one misnamed environment variable and the app serves the Google
 * Maps key out of its bundle and mints OpenAI sessions for anybody.
 *
 * A deployment must therefore refuse to serve rather than serve unprotected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { basicAuthGate } from './basicAuthGate.js';

function install(plugin) {
  const handlers = [];
  plugin.configurePreviewServer?.({ middlewares: { use: (...a) => handlers.push(a[a.length - 1]) } });
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

const creds = { user: 'andrew', password: 'pw' };
const header = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

test('localhost with no credentials still runs unguarded', () => {
  assert.equal(install(basicAuthGate({})).length, 0, 'local dev must not be forced to authenticate');
});

test('a required gate with no credentials refuses every request', async () => {
  const [handler] = install(basicAuthGate({ required: true }));
  assert.ok(handler, 'a required gate must install a handler even with no credentials');

  const { res, next } = await run(handler);
  assert.equal(next, false, 'must not reach the app');
  assert.equal(res.statusCode, 503, 'misconfiguration is unavailable, not unauthorized');
});

test('a required gate refuses even when correct-looking credentials are offered', async () => {
  // There is no secret to match, so nothing can be correct.
  const [handler] = install(basicAuthGate({ required: true }));
  const { next } = await run(handler, header('andrew', 'pw'));
  assert.equal(next, false);
});

test('a half-configured required gate refuses rather than matching an empty secret', async () => {
  const [handler] = install(basicAuthGate({ user: 'andrew', required: true }));
  const { res, next } = await run(handler, header('andrew', ''));
  assert.equal(next, false);
  assert.equal(res.statusCode, 503);
});

test('a required gate with real credentials behaves normally', async () => {
  const [handler] = install(basicAuthGate({ ...creds, required: true }));

  const denied = await run(handler);
  assert.equal(denied.res.statusCode, 401, 'no credentials is still a challenge, not a 503');

  const allowed = await run(handler, header('andrew', 'pw'));
  assert.equal(allowed.next, true);
});

test('the refusal does not leak which variable is missing', async () => {
  const [handler] = install(basicAuthGate({ user: 'andrew', required: true }));
  const { res } = await run(handler);
  assert.doesNotMatch(String(res.body), /andrew|password|GEV_AUTH/i, `leaked config detail: ${res.body}`);
});
