/**
 * The cost-endpoint gate must admit the app's own requests behind Cloud Run.
 *
 * Upstream's same-site gate refuses any request carrying forwarding headers,
 * which is right for a laptop and fatal for this deployment: Cloud Run's front
 * end adds X-Forwarded-For/-Proto to every request, so on v15 (2026-10-17) the
 * live voice token, HUD summary and nearby-places all answered 403 "Proxied
 * requests are not accepted". The socket there is also plain http while the
 * browser's Origin is https, so the exact-origin check failed too.
 *
 * GEV_TRUSTED_PROXY_HOPS is this fork's existing declaration that a known
 * proxy sits in front. Only then are the forwarding headers expected, and the
 * scheme is read from X-Forwarded-Proto. Cross-site checks still apply.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sameSiteGated } from '../../server/providers/common/same-site.js';

const HOST = 'gods-eye-view-808373260790.us-central1.run.app';

function call(t, hops, headers) {
  const saved = process.env.GEV_TRUSTED_PROXY_HOPS;
  if (hops === undefined) delete process.env.GEV_TRUSTED_PROXY_HOPS;
  else process.env.GEV_TRUSTED_PROXY_HOPS = hops;
  t.after(() => {
    if (saved === undefined) delete process.env.GEV_TRUSTED_PROXY_HOPS;
    else process.env.GEV_TRUSTED_PROXY_HOPS = saved;
  });
  let reached = false;
  let status = 200;
  const res = { setHeader() {}, end() {}, set statusCode(v) { status = v; }, get statusCode() { return status; } };
  sameSiteGated(() => { reached = true; })({ headers: { host: HOST, ...headers }, socket: {} }, res);
  return { reached, status };
}

const CLOUD_RUN = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' };
const APP = { origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin' };

test('the app itself is admitted behind a declared proxy', (t) => {
  assert.equal(call(t, '1', { ...CLOUD_RUN, ...APP }).reached, true);
});

test('a foreign origin is still refused behind a declared proxy', (t) => {
  const r = call(t, '1', { ...CLOUD_RUN, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  assert.equal(r.reached, false);
  assert.equal(r.status, 403);
});

test('without the declaration, forwarding headers are still refused', (t) => {
  for (const hops of [undefined, '0']) {
    assert.equal(call(t, hops, { ...CLOUD_RUN, ...APP }).reached, false);
  }
});
