#!/usr/bin/env node
/**
 * qa-outline-render — does "outline X" actually put a traced perimeter on the map?
 *
 * Not "did the model call annotate_map". That check has been green while the
 * mark on screen was a bare dot, which is the whole reason this exists: an area
 * annotation renders as a point IMMEDIATELY, then Overpass supplies the real
 * boundary and the mark is upgraded in place. When that fetch fails the point
 * simply stays a point, no error, no retry visible to anyone.
 *
 * So this drives the annotation engine directly and reports the outcome the
 * engine itself publishes via onOutlineEvent, plus the final geometry:
 *
 *   TRACED PERIMETER   real ring, N points        <- what "outline it" should do
 *   SYNTHESIZED BLOB   a buffered circle, not a boundary
 *   STILL PENDING      the upgrade never landed
 *   BARE POINT         no perimeter at all
 *
 * Driving the engine rather than the voice agent is deliberate: it isolates
 * rendering from speech, and it keeps working when the realtime API is rate
 * limited.
 *
 * Usage: node scripts/qa-outline-render.mjs [--url ...] [--auth u:p]
 *        [--targets "Presidio, San Francisco|Golden Gate Park, San Francisco"]
 *        [--wait 25000]
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const arg = (f, d) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : d);
const url = arg('--url', 'http://localhost:4173');
const auth = arg('--auth', null);
const waitMs = Number(arg('--wait', '25000'));
const targets = arg('--targets', 'Presidio, San Francisco|Golden Gate Park, San Francisco')
  .split('|').map((t) => t.trim()).filter(Boolean);

const chrome = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

const browser = await puppeteer.launch({
  headless: false,
  ...(chrome ? { executablePath: chrome } : {}),
  protocolTimeout: 240_000,
  args: ['--force-high-performance-gpu', '--window-size=1280,860'],
});

try {
  const page = await browser.newPage();
  if (auth) {
    const [u, ...rest] = auth.split(':');
    await page.authenticate({ username: u, password: rest.join(':') });
  }
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[Resolver]')) console.log(`  resolver: ${t.slice(0, 200)}`);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__godsEyeView?.annotations?.annotate, {
    timeout: 150000, polling: 1000,
  });

  // Record every deferred-outline outcome the engine publishes.
  await page.evaluate(() => {
    window.__outlineEvents = [];
    window.__godsEyeView.annotations.onOutlineEvent((e) => window.__outlineEvents.push(e));
  });

  // Optionally frame the area first. Resolution is viewport-biased, so "outline
  // the Presidio" from a camera over Texas is not the same request as the same
  // words spoken while already over San Francisco.
  const flyTo = (process.argv.includes('--fly') ? process.argv[process.argv.indexOf('--fly') + 1] : null);
  if (flyTo) {
    const [lat, lon, height] = flyTo.split(',').map(Number);
    // The app flies to Austin on startup; that animation silently overrides a
    // setView issued while it is still running, which is how an earlier run of
    // this probe "moved" the camera and still measured the Austin distance.
    await page.evaluate(async (la, lo, h) => {
      const v = window.__godsEyeView.viewer;
      v.camera.cancelFlight?.();
      v.camera.setView({ destination: window.Cesium.Cartesian3.fromDegrees(lo, la, h || 12000) });
    }, lat, lon, height);
    await new Promise((r) => setTimeout(r, 5000));
    const at = await page.evaluate(() => {
      const c = window.__godsEyeView.viewer.camera.positionCartographic;
      const D = window.Cesium.Math.toDegrees;
      return { lat: +D(c.latitude).toFixed(4), lon: +D(c.longitude).toFixed(4), km: Math.round(c.height / 1000) };
    });
    console.log(`  camera now at ${at.lat},${at.lon} @ ${at.km}km (asked for ${lat},${lon})`);
    if (Math.abs(at.lat - lat) > 0.5 || Math.abs(at.lon - lon) > 0.5) {
      console.log('  [warn] camera did not hold the requested position — a flight is still running');
    }
  }

  const result = await page.evaluate(async (list) => {
    const engine = window.__godsEyeView.annotations;
    return engine.annotate(
      list.map((target) => ({ type: 'area', target })),
      { clearPrevious: true, flyTo: false },
    );
  }, targets);

  console.log(`\nrequested ${targets.length} area outline(s): ${targets.join(' | ')}`);
  console.log(`  engine: ok=${result.ok} drawn=${result.drawn} failed=${result.failed}`);
  for (const r of result.results || []) {
    if (!r?.ok) { console.log(`  immediate: ${JSON.stringify(r?.error || r)}`); continue; }
    console.log(`  immediate: ${JSON.stringify(r.label)} outline=${r.outline}`
      + `${r.outlinePending ? ' (upgrade pending)' : ''}${r.approximate ? ' (approximate)' : ''}`);
  }

  // The upgrade is asynchronous by design; this is the window it gets.
  await new Promise((r) => setTimeout(r, waitMs));

  const marks = await page.evaluate(() => ({
    events: window.__outlineEvents,
    marks: (window.__godsEyeView.annotations.list() || []).map((a) => ({
      type: a.type,
      label: a.label,
      ringPoints: Array.isArray(a.ring) ? a.ring.length : null,
      pendingOutline: Boolean(a.pendingOutline),
      synthesized: Boolean(a.synthesized),
    })),
  }));

  console.log('\nafter the upgrade window:');
  let traced = 0;
  for (const m of marks.marks) {
    const verdict = m.ringPoints ? `TRACED PERIMETER (${m.ringPoints} points)`
      : m.pendingOutline ? 'STILL PENDING - no perimeter drawn'
      : m.synthesized ? 'SYNTHESIZED BLOB - not a real boundary'
      : 'BARE POINT - no perimeter';
    if (m.ringPoints) traced += 1;
    console.log(`  ${JSON.stringify(m.label)} [${m.type}] -> ${verdict}`);
  }
  if (!marks.marks.length) console.log('  (no marks on the board)');
  for (const e of marks.events) {
    console.log(`  event: ${JSON.stringify(e.label)} ${e.status}${e.approximate ? ' (approximate)' : ''}`);
  }

  console.log(`\nRESULT: ${traced}/${targets.length} traced a real perimeter`);
  process.exitCode = traced === targets.length ? 0 : 1;
} finally {
  await browser.close();
}
