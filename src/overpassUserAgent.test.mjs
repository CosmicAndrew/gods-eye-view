/**
 * The Overpass proxy's User-Agent must not get itself refused.
 *
 * overpass-api.de fronts Overpass with Apache rules that reject some agent
 * strings outright, before the query is even parsed. Measured against the live
 * mirror on 2026-09-12 with one identical query:
 *
 *   gods-eye-view-overpass-proxy/1.0                      -> 406
 *   gods-eye-view-overpass-proxy/1.0 (+https://github...) -> 406
 *   gods-eye-view/1.0 (+https://github...)                -> 200
 *   curl/8.0                                              -> 200
 *
 * Both refused strings carry the token "proxy"; neither accepted one does. That
 * cost two of the four mirrors — overpass-api.de and its lz4 alias are the same
 * operator — and left the fan-out leaning on a community mirror that answers in
 * ~21s against a 22s per-mirror timeout. Area annotations get their perimeter
 * from Overpass, so when that budget is missed the outline never arrives and
 * the mark stays a bare point.
 *
 * The sibling celestrak proxy already uses the OSM-etiquette form (descriptive
 * name + contact URL, no "proxy"); this pins Overpass to the same convention.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** The User-Agent the Overpass fan-out sends upstream. */
function overpassUserAgent() {
  // Upstream split the proxy: transport.js sends OVERPASS_USER_AGENT, which
  // constants.js defines. Upstream adopted the same no-"proxy" form itself.
  const transport = read('server/providers/overpass/transport.js');
  assert.match(transport, /'User-Agent':\s*OVERPASS_USER_AGENT/, 'the fan-out no longer sends the shared constant');
  const match = read('server/providers/overpass/constants.js')
    .match(/const OVERPASS_USER_AGENT =\s*'([^']+)'/);
  assert.ok(match, 'OVERPASS_USER_AGENT not found — did the proxy move?');
  return match[1];
}

test('the Overpass User-Agent avoids the token that gets it refused', () => {
  assert.doesNotMatch(
    overpassUserAgent(),
    /proxy/i,
    'overpass-api.de answers 406 to an agent string containing "proxy", '
    + 'costing two of four mirrors before the query is even read',
  );
});

test('the Overpass User-Agent carries a contact URL, as OSM etiquette asks', () => {
  const ua = overpassUserAgent();
  assert.match(ua, /\(\+https:\/\/\S+\)/, 'no (+contact-url) in the agent string');
  assert.match(ua, /gods-eye-view/, 'the agent string should still name this app');
});

test('the celestrak proxy keeps the same convention', () => {
  // The form being copied here, so the two cannot drift apart unnoticed.
  const match = read('server/providers/space/celestrak.js')
    .match(/'User-Agent':\s*'(gods-eye-view-celestrak[^']+)'/);
  assert.ok(match, 'celestrak User-Agent not found');
  assert.match(match[1], /\(\+https:\/\/\S+\)/);
});
