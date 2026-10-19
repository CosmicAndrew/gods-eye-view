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

test('a bare airport code matches its own parenthetical code', () => {
  // "annotate LAX" from a far camera: the geocoder returns the full name with
  // the code, and the code echoes the whole ask. Found in review.
  assert.equal(matches('LAX', 'Los Angeles International Airport (LAX)', AIRPORT), true);
  assert.equal(matches('DFW', 'Dallas/Fort Worth International Airport (DFW)', AIRPORT), true);
  assert.equal(matches('lax', 'Los Angeles International Airport (LAX)', AIRPORT), true);
});

test('a code match still requires a transport-hub type', () => {
  // No airport type = no bypass, even if a code happens to echo.
  assert.equal(matches('OSU', 'Ohio State University (OSU)', ['university']), false);
});

test('a partial or wrong code does not match', () => {
  assert.equal(matches('LA', 'Los Angeles International Airport (LAX)', AIRPORT), false);
  assert.equal(matches('SFO', 'Los Angeles International Airport (LAX)', AIRPORT), false);
});

test('an ask that names its own locality is self-disambiguating', () => {
  // The gate stands in for "where are we, roughly". When the ask CARRIES a
  // locality the user has already answered that, so the camera has nothing to
  // add. Measured: "outline the Presidio" from a camera over Austin was refused
  // outright ("could not resolve location", 2431km > 50km) while the identical
  // request with the camera over San Francisco traced a 196-point perimeter.
  assert.equal(matches('Presidio, San Francisco', 'Presidio of San Francisco', ['park']), true);
  assert.equal(matches('Golden Gate Park, San Francisco', 'Golden Gate Park', ['park']), true);
  assert.equal(matches('Palace of Fine Arts, San Francisco', 'Palace of Fine Arts', ['tourist_attraction']), true);
  assert.equal(matches('the Pentagon, Arlington', 'The Pentagon', ['premise']), true);
});

test('an unqualified ask still leans on the viewport', () => {
  // No locality in the ask = the gate is the only disambiguator left, so the
  // pre-existing guarded cases must not move.
  assert.equal(matches('Empire State', 'Empire State', ['premise', 'tourist_attraction']), false);
  assert.equal(matches('Ohio State', 'Ohio State', ['university']), false);
  assert.equal(matches('the Texas Capitol', 'Texas', ['administrative_area_level_1']), false);
  assert.equal(matches('Chinatown', 'Chinatown', ['neighborhood']), false);
});

test('a locality qualifier does not excuse a name that missed', () => {
  // Qualified or not, the geocoder still has to have returned the thing asked
  // for — "the Texas Capitol, Austin" coming back as the STATE stays gated.
  assert.equal(matches('the Texas Capitol, Austin', 'Texas', ['administrative_area_level_1']), false);
  assert.equal(matches('Zilker Park, Austin', 'Lady Bird Lake', ['park']), false);
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
