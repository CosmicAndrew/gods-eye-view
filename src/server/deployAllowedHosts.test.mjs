/**
 * The Cloud Run deploy must name its hosts exactly.
 *
 * Upstream's Host check (build/allowedHosts.js) drops leading-dot and `*`
 * entries from GEV_ALLOWED_HOSTS on purpose — a suffix wildcard is what a
 * DNS-rebinding attack needs. The deploy script used to set `.run.app` "so the
 * service works before its hostname is known"; after the 2026-10-16 merge that
 * value allows nothing, and every request to the live service is a 403.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveAllowedHosts, isAllowedHost } from '../../build/allowedHosts.js';

const script = readFileSync(new URL('../../scripts/deploy-cloudrun.ps1', import.meta.url), 'utf8');

test('a suffix entry really does allow nothing (the premise)', () => {
  // If upstream ever relaxes this, the rest of this file is moot - say so.
  const hosts = resolveAllowedHosts('.run.app');
  assert.equal(isAllowedHost('gods-eye-view-808373260790.us-central1.run.app', hosts), false);
});

test('the deploy script never assigns a wildcard GEV_ALLOWED_HOSTS', () => {
  const assignments = [...script.matchAll(/\$vars\['GEV_ALLOWED_HOSTS'\]\s*=\s*([^\r\n]+)/g)].map((m) => m[1]);
  assert.ok(assignments.length > 0, 'the script no longer sets GEV_ALLOWED_HOSTS at all');
  for (const value of assignments) {
    assert.doesNotMatch(value, /['"][.*]/, `wildcard host assignment: ${value}`);
  }
});

test('the hosts come from the service\'s own URLs', () => {
  // The run.googleapis.com/urls annotation lists every hostname Cloud Run
  // routes to the service (both the project-number and the hash form).
  assert.match(script, /run\.googleapis\.com\/urls/);
});
