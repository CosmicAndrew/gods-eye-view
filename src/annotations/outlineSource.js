import { readResponseJsonCapped } from '../sources/httpBody.js';

const OUTLINE_MAX_BYTES = 512 * 1024;

/**
 * A named place's OpenStreetMap outline from the server's Nominatim proxy.
 *
 * The resolver asks for this only when no Overpass endpoint is configured.
 * Resolves `{ ring: [[lon, lat], ...], kind, name }`, or null when there is no
 * outline to draw (unknown place, point-only feature, upstream failure).
 */
export async function fetchPlaceOutline(
  { query, lat, lon, signal } = {},
  fetchImpl = (...args) => globalThis.fetch(...args),
) {
  const text = String(query || '').trim();
  if (!text) return null;
  const params = new URLSearchParams({ q: text.slice(0, 200) });
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set('lat', lat.toFixed(5));
    params.set('lon', lon.toFixed(5));
  }
  const response = await fetchImpl(`/api/geocode/outline?${params}`, {
    signal,
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const body = await readResponseJsonCapped(response, OUTLINE_MAX_BYTES);
  return Array.isArray(body?.ring) && body.ring.length >= 3 ? body : null;
}
