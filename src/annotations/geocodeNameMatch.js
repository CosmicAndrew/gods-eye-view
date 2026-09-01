/**
 * Did the geocoder echo back the name the user actually gave?
 *
 * The resolver rejects a geocoded point that sits far from the current view,
 * which is right when a vague local ask resolves to a distant wrong thing —
 * "the Texas Capitol" coming back as the STATE of Texas. It is wrong when the
 * user named a place in full and the geocoder returned exactly that place:
 * marking LAX from a camera over Texas is not a mis-match, it is the request.
 * That case was rejected at 1991km against a 50km limit and reported to the
 * user as "nothing could be marked".
 *
 * A name echo alone is not enough: "Empire State" geocodes to an exact echo
 * while meaning the Building, and the resolver deliberately keeps that on the
 * near-view recovery path. So the bypass also requires the geocoder's own type
 * to name an unambiguous transport hub - the class the launch demo marks and
 * the class whose full name admits no second reading.
 */

/** Geocode types whose named facility is unambiguous wherever the camera is. */
const UNAMBIGUOUS_TYPES = new Set([
  'airport', 'international_airport', 'transit_station',
  'train_station', 'bus_station', 'subway_station', 'ferry_terminal',
]);

/** Lowercase, drop a leading article, strip punctuation and parenthetical codes. */
function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')      // "(LAX)" is a code, not part of the name
    .replace(/^\s*the\s+/, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const tokens = (value) => normalize(value).split(' ').filter(Boolean);

/**
 * @param {string} query        what the user asked for
 * @param {string} primaryName  the geocoder's canonical name for what it found
 * @param {string[]} [types]    the geocoder's types for that result
 * @returns {boolean} true when the result is an unambiguous echo of the ask and
 *   may skip the proximity gate; false whenever the gate should still apply.
 */
export function geocodeNameConfidentlyMatches(query, primaryName, types = []) {
  if (!Array.isArray(types) || !types.some((t) => UNAMBIGUOUS_TYPES.has(String(t)))) return false;

  // A bare code echoes the whole ask: "annotate LAX" against a geocoder result
  // of "... (LAX)". The type gate above already confirmed a transport hub, so a
  // code that equals the ask is unambiguous. Checked before the parens are
  // stripped, since that is where the code lives.
  const askJoined = tokens(query).join(' ');
  const codes = [...String(primaryName ?? '').matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  if (askJoined && codes.some((c) => tokens(c).join(' ') === askJoined)) return true;

  const askTokens = tokens(query);
  const gotTokens = tokens(primaryName);
  if (!askTokens.length || !gotTokens.length) return false;

  // An exact echo is unambiguous at any distance, including a single word.
  if (askTokens.join(' ') === gotTokens.join(' ')) return true;

  // Otherwise the canonical name has to account for the ask rather than a
  // fragment of it. One token out of several is the "Texas Capitol" → "Texas"
  // shape the gate is there to catch, so it stays gated.
  if (gotTokens.length < 2) return false;

  const ask = new Set(askTokens);
  return gotTokens.every((token) => ask.has(token));
}
