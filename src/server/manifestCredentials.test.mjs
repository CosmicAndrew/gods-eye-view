/**
 * The web app manifest must be fetched with credentials.
 *
 * Browsers request a manifest in `omit` credentials mode unless its link says
 * otherwise, and `omit` withholds HTTP Basic credentials too. Behind this
 * fork's password gate that is a 401 on every load ("Manifest fetch ... failed,
 * code 401" in the console), so installing the app to a home screen gets a
 * blank tile — the exact thing upstream's manifest exists to prevent.
 * `use-credentials` on a same-origin manifest changes nothing for an ungated
 * deployment.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

test('the manifest link sends the gate credentials', () => {
  const link = html.match(/<link\b[^>]*\brel="manifest"[^>]*>/);
  assert.ok(link, 'no manifest link in index.html');
  assert.match(link[0], /\bcrossorigin="use-credentials"/);
});
