#!/usr/bin/env node
/**
 * qa-capability-sweep — can the app actually DO the things the tour shows?
 *
 * Drives the real engines directly (no speech, no realtime quota) and reports
 * what ended up on the map, because "the model emitted the tool call" has been
 * green through every failure found so far.
 *
 * Covers the three things a user names when they say it "can't do what I ask":
 *   marks      — pin / highlight / area / arrow / route, and whether each drew
 *   vehicles   — flights, military, vessels, satellites: enabled AND populated
 *   distinctions — the colour coding that separates one mark or track from another
 *
 * Usage: node scripts/qa-capability-sweep.mjs [--url ...] [--auth u:p] [--wait 25000]
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const arg = (f, d) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : d);
const url = arg('--url', 'http://localhost:4173');
const auth = arg('--auth', null);
const waitMs = Number(arg('--wait', '25000'));

const chrome = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

const browser = await puppeteer.launch({
  headless: false,
  ...(chrome ? { executablePath: chrome } : {}),
  protocolTimeout: 300_000,
  args: ['--force-high-performance-gpu', '--window-size=1280,860'],
});

try {
  const page = await browser.newPage();
  if (auth) {
    const [u, ...rest] = auth.split(':');
    await page.authenticate({ username: u, password: rest.join(':') });
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__godsEyeView?.annotations?.annotate, {
    timeout: 150000, polling: 1000,
  });

  // ── marks ────────────────────────────────────────────────────────────────
  // One of each shape the schema offers, all named with their locality so the
  // proximity gate is not the thing under test here.
  const marks = await page.evaluate(async () => {
    const engine = window.__godsEyeView.annotations;
    const res = await engine.annotate([
      { type: 'pin', target: 'Port of Rotterdam, Netherlands' },
      { type: 'highlight', target: 'Rotterdam Centraal, Netherlands' },
      { type: 'area', target: 'Golden Gate Park, San Francisco' },
      { type: 'arrow', target: 'Port of Rotterdam, Netherlands', toTarget: 'Port of Antwerp, Belgium' },
      { type: 'label', target: 'Erasmusbrug, Rotterdam', color: 'amber' },
      { type: 'pin', target: 'Port of Antwerp, Belgium', color: 'cyan' },
      { type: 'pin', target: 'Rotterdam Ahoy, Netherlands', color: 'red' },
    ], { clearPrevious: true, flyTo: false });
    return { ok: res.ok, drawn: res.drawn, failed: res.failed, results: res.results };
  });

  console.log('\nMARKS — one of each shape');
  for (const r of marks.results || []) {
    if (!r?.ok) { console.log(`  FAILED  ${JSON.stringify(r?.error || r)}`); continue; }
    const extra = [
      r.outline ? 'outline' : null,
      r.outlinePending ? 'outline-pending' : null,
      r.approximate ? 'approximate' : null,
    ].filter(Boolean).join(', ');
    console.log(`  drawn   ${String(r.type).padEnd(9)} ${JSON.stringify(r.label)}${extra ? `  (${extra})` : ''}`);
  }
  console.log(`  => ok=${marks.ok} drawn=${marks.drawn} failed=${marks.failed}`);

  // ── distinctions ─────────────────────────────────────────────────────────
  const colours = await page.evaluate(() => {
    const list = window.__godsEyeView.annotations.list() || [];
    const seen = list.map((a) => ({ label: a.label, type: a.type, color: a.color ?? a.colorKey ?? null }));
    return { seen, distinct: new Set(seen.map((s) => String(s.color))).size };
  });
  console.log('\nDISTINCTIONS — do marks differ from one another?');
  for (const c of colours.seen) console.log(`  ${String(c.type).padEnd(9)} ${JSON.stringify(c.label)} color=${c.color}`);
  console.log(`  => ${colours.distinct} distinct colour(s) across ${colours.seen.length} marks`);

  // ── vehicles ─────────────────────────────────────────────────────────────
  const layers = ['flights', 'military', 'ais-live-vessels', 'satellites'];
  const enabled = await page.evaluate(async (ids) => {
    const dm = window.__godsEyeView.dataManager;
    const out = [];
    for (const id of ids) {
      try { await dm.setEnabled(id, true, { origin: 'user' }); out.push({ id, enabled: true }); }
      catch (e) { out.push({ id, enabled: false, error: String(e?.message || e) }); }
    }
    return out;
  }, layers);
  console.log('\nVEHICLES — enabling the moving-thing layers');
  for (const e of enabled) console.log(`  ${e.id.padEnd(18)} ${e.enabled ? 'enabled' : `FAILED ${e.error}`}`);

  console.log(`\n  ...waiting ${Math.round(waitMs / 1000)}s for feeds to populate`);
  await new Promise((r) => setTimeout(r, waitMs));

  const counts = await page.evaluate((ids) => {
    const dm = window.__godsEyeView.dataManager;
    return ids.map((id) => {
      const mod = dm.layers?.get?.(id)?.module;
      const s = mod?.getStats?.() || {};
      return {
        id,
        count: s.count ?? null,
        error: s.error ?? null,
        keyRequired: Boolean(s.keyRequired),
        loading: Boolean(s.loading),
      };
    });
  }, layers);
  console.log('\n  after the wait:');
  let live = 0;
  for (const c of counts) {
    const verdict = c.keyRequired ? 'KEY REQUIRED'
      : c.count > 0 ? `${c.count} tracks`
      : c.loading ? 'still loading'
      : c.error ? `no data (${String(c.error).slice(0, 60)})`
      : 'no data';
    if (c.count > 0) live += 1;
    console.log(`  ${c.id.padEnd(18)} ${verdict}`);
  }

  console.log(`\nRESULT: marks ${marks.drawn}/5 drawn · vehicle layers with live tracks ${live}/${layers.length}`);
  process.exitCode = marks.drawn === 5 && live > 0 ? 0 : 1;
} finally {
  await browser.close();
}
