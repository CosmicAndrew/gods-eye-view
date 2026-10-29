import { readResponseJsonCapped } from '../sources/httpBody.js';

const OUTLINE_MAX_BYTES = 512 * 1024;

/**
 * A named place's OpenStreetMap outline from the server's Nominatim proxy.
 *
 * The resolver asks for this only when no Overpass endpoint is configured.
 * Resolves `{ ring: [[lon, lat], ...], kind, name }`, a road or river's
 * `{ line, kind: 'line', category, name }`, or null when there is no outline
 * to draw (unknown place, point-only feature, upstream failure). An empty
 * query asks for the feature at lat/lon.
 */
export async function fetchPlaceOutline(
  { query, lat, lon, signal } = {},
  fetchImpl = (...args) => globalThis.fetch(...args),
) {
  const text = String(query || '').trim();
  const located = Number.isFinite(lat) && Number.isFinite(lon);
  if (!text && !located) return null;
  const params = new URLSearchParams(text ? { q: text.slice(0, 200) } : {});
  if (located) {
    params.set('lat', lat.toFixed(6));
    params.set('lon', lon.toFixed(6));
  }
  const response = await fetchImpl(`/api/geocode/outline?${params}`, {
    signal,
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const body = await readResponseJsonCapped(response, OUTLINE_MAX_BYTES);
  if (Array.isArray(body?.ring) && body.ring.length >= 3) return body;
  return Array.isArray(body?.line) && body.line.length >= 2 ? body : null;
}
