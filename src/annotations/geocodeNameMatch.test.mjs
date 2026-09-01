/**
 * The proximity gate throws away correctly-geocoded places.
 *
 * Observed: asking to mark LAX and DFW while the camera sits elsewhere returns
 * "nothing could be marked", and the resolver's own log says why —
 *   "Los Angeles International Airport (LAX)": geocode=33.94215,-118.40361
 *      → FINAL source=rejected (proximity gate, 1991km > 50km)
 * The geocoder was right; the guard discarded it for being far from the view.
 *
 * The guard is not wrong in general: it catches a vague local ask resolving to
 * a distant wrong thing ("the Texas Capitol" → the state of Texas). Nor is a
 * name echo enough on its own — "Empire State" echoes exactly while meaning the
 * Building, and the resolver keeps that guarded on purpose.
 *
 * So the bypass is deliberately narrow: the geocoder's own type must name an
 * unambiguous transport hub AND the canonical name must account for the ask.
 * That is the class the launch demo marks, and the class whose full name admits
 * no second reading.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { geocodeNameConfidentlyMatches as matches } from './geocodeNameMatch.js';

/** What Google returns for a major airport. */
const AIRPORT = ['airport', 'point_of_interest', 'establishment'];

test('the airport case from the demo matches, code and all', () => {
  assert.equal(matches('Los Angeles International Airport (LAX)', 'Los Angeles International Airport', AIRPORT), true);
  assert.equal(matches('Dallas/Fort Worth International Airport (DFW)', 'Dallas Fort Worth International Airport', AIRPORT), true);
});

test('a non-transport place never bypasses, however exact the echo', () => {
  // The resolver keeps these on the near-view recovery path on purpose.
  assert.equal(matches('Empire State', 'Empire State', ['premise', 'tourist_attraction']), false);
  assert.equal(matches('Ohio State', 'Ohio State', ['university']), false);
  assert.equal(matches('Texas', 'Texas', ['administrative_area_level_1']), false);
  assert.equal(matches('Chinatown', 'Chinatown', ['neighborhood']), false);
});

test('the wrong-match the guard exists for is still caught', () => {
  assert.equal(matches('the Texas Capitol', 'Texas', AIRPORT), false);
  assert.equal(matches('Austin City Hall', 'Austin', AIRPORT), false);
});

test('a single-token echo only matches when it is the whole ask', () => {
  assert.equal(matches('Heathrow', 'Heathrow', AIRPORT), true);
  assert.equal(matches('Heathrow Airport Terminal 5', 'Heathrow', AIRPORT), false, 'one token of a longer ask is the risky case');
});

test('case, punctuation and a leading article do not decide it', () => {
  assert.equal(matches('the HEATHROW', 'Heathrow', AIRPORT), true);
  assert.equal(matches('Dallas/Fort Worth Intl. Airport', 'Dallas Fort Worth Intl Airport', AIRPORT), true);
});

test('unrelated names never match', () => {
  assert.equal(matches('Los Angeles International Airport', 'Denver International Airport', AIRPORT), false);
  assert.equal(matches('Zilker Park', 'Lady Bird Lake', AIRPORT), false);
});

test('missing types, or empty input, is not a match', () => {
  assert.equal(matches('Los Angeles International Airport', 'Los Angeles International Airport'), false, 'no types = no bypass');
  for (const [q, p] of [[null, 'X'], ['X', null], ['', ''], ['  ', 'X'], [undefined, undefined]]) {
    assert.equal(matches(q, p, AIRPORT), false, `expected false for ${JSON.stringify([q, p])}`);
  }
});
