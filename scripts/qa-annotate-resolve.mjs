#!/usr/bin/env node
/**
 * qa-annotate-resolve — why does annotating a named place fail in the app when
 * every upstream answers fine from a shell?
 *
 * The launch demo marks LAX and DFW on request. Today the agent calls
 * annotate_map correctly and the tool comes back "could not pinpoint", while
 * curl against Geocoding, Places and Overpass all succeed. The difference that
 * matters is WHERE the call is made from: the resolver runs in the page, with
 * the page's origin, referrer and key restrictions.
 *
 * This runs the same three lookups inside the browser and reports each status,
 * so the failing hop is named instead of guessed. No voice session is used -
 * it isolates resolution from the Realtime API entirely.
 *
 * Usage: node scripts/qa-annotate-resolve.mjs [--url ...] [--auth u:p] [--place "LAX"]
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const url = arg('--url', 'http://localhost:4173');
const auth = arg('--auth', null);
const place = arg('--place', 'Los Angeles International Airport');

const chromePath = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

const browser = await puppeteer.launch({
  headless: false,
  ...(chromePath ? { executablePath: chromePath } : {}),
  protocolTimeout: 120_000,
  args: ['--force-high-performance-gpu', '--window-size=1280,800'],
});

try {
  const page = await browser.newPage();
  if (auth) {
    const [username, ...rest] = auth.split(':');
    await page.authenticate({ username, password: rest.join(':') });
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => Boolean(document.querySelector('.cesium-widget canvas')), { timeout: 90000 });

  const result = await page.evaluate(async (query) => {
    const out = { keyInBundle: null, geocode: null, places: null, overpass: null };
    const key = window.__GOOGLE_MAPS_API_KEY__ || undefined;
    out.keyInBundle = key ? `present (${String(key).slice(0, 6)}…)` : 'ABSENT from window.__GOOGLE_MAPS_API_KEY__';

    // 1. Geocoding — how the resolver turns a place name into a point.
    try {
      const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}${key ? `&key=${key}` : ''}`);
      const j = await r.json();
      out.geocode = `HTTP ${r.status} · status=${j.status}${j.error_message ? ` · ${j.error_message}` : ''}`;
      if (j.results?.[0]) {
        const loc = j.results[0].geometry.location;
        out.point = `${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`;
      }
    } catch (e) { out.geocode = `THREW ${e.name}: ${e.message}`; }

    // 2. Places text search — the fallback when geocoding has no match.
    try {
      const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key || '', 'X-Goog-FieldMask': 'places.displayName' },
        body: JSON.stringify({ textQuery: query }),
      });
      out.places = `HTTP ${r.status}`;
      if (!r.ok) out.places += ` · ${(await r.text()).slice(0, 120)}`;
    } catch (e) { out.places = `THREW ${e.name}: ${e.message}`; }

    // 3. Overpass, same-origin through the app's own proxy.
    if (out.point) {
      const [lat, lon] = out.point.split(',');
      const q = `[out:json][timeout:25];(way(around:1800,${lat},${lon})["aeroway"="aerodrome"];relation(around:1800,${lat},${lon})["aeroway"="aerodrome"];);out geom;`;
      try {
        const r = await fetch('/api/overpass', { method: 'POST', body: new URLSearchParams({ data: q }) });
        const j = await r.json().catch(() => null);
        out.overpass = `HTTP ${r.status} · elements=${j?.elements?.length ?? 'n/a'}`;
      } catch (e) { out.overpass = `THREW ${e.name}: ${e.message}`; }
    }
    return out;
  }, place);

  console.log(`place: ${place}`);
  for (const [k, v] of Object.entries(result)) console.log(`  ${k.padEnd(13)} ${v}`);
} finally {
  await browser.close();
}
