#!/usr/bin/env node
/**
 * qa-layer-errors — turn on every layer, one at a time, and report what breaks.
 *
 * A default page load exercises almost nothing: the boot smoke test comes back
 * clean while individual layers still fail on activation. This attributes each
 * console error, failed request and >=400 response to the layer that was being
 * switched on when it happened, so "there are loading errors" becomes a list.
 *
 * Usage: node scripts/qa-layer-errors.mjs [--url ...] [--auth user:pass] [--dwell 6000]
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const url = arg('--url', 'http://localhost:4173');
const auth = arg('--auth', null);
const dwell = Number(arg('--dwell', '6000'));

const chromePath = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

const browser = await puppeteer.launch({
  headless: false,
  ...(chromePath ? { executablePath: chromePath } : {}),
  args: ['--force-high-performance-gpu', '--window-size=1440,900'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  if (auth) {
    const [username, ...rest] = auth.split(':');
    await page.authenticate({ username, password: rest.join(':') });
  }

  let bucket = [];
  page.on('console', (m) => { if (m.type() === 'error') bucket.push(`console: ${m.text().slice(0, 220)}`); });
  page.on('pageerror', (e) => bucket.push(`pageerror: ${String(e?.message || e).slice(0, 220)}`));
  page.on('requestfailed', (r) => {
    const t = r.failure()?.errorText || '';
    // Cesium cancels in-flight tile requests on every camera move; that is normal.
    if (t.includes('ERR_ABORTED')) return;
    bucket.push(`requestfailed: ${t} ${r.url().slice(0, 130)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) bucket.push(`http ${r.status()}: ${r.url().replace(/key=[^&]+/, 'key=REDACTED').slice(0, 150)}`);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => Boolean(document.querySelector('.cesium-widget canvas')), { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 8000)); // let the intro flight settle

  const layers = await page.evaluate(() =>
    [...document.querySelectorAll('#data-toggles [data-layer-id]')].map((el, i) => ({
      index: i,
      id: el.getAttribute('data-layer-id'),
      label: (el.textContent || '').trim().slice(0, 40),
    })));

  if (!layers.length) {
    console.log('no [data-layer-id] toggles found; DOM sample:');
    console.log(await page.evaluate(() => document.getElementById('data-toggles')?.innerHTML?.slice(0, 600)));
    process.exitCode = 1;
  } else {
    console.log(`checking ${layers.length} layers\n`);
    const report = [];
    for (const layer of layers) {
      bucket = [];
      await page.evaluate((id) => {
        const el = document.querySelector(`#data-toggles [data-layer-id="${id}"]`);
        (el.querySelector('input,button') || el).click();
      }, layer.id);
      await new Promise((r) => setTimeout(r, dwell));
      const problems = [...new Set(bucket)];
      report.push({ layer: layer.id, problems });
      console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${layer.id}${problems.length ? `\n${problems.map((p) => `        ${p}`).join('\n')}` : ''}`);
      // Switch it back off so layers are measured independently.
      await page.evaluate((id) => {
        const el = document.querySelector(`#data-toggles [data-layer-id="${id}"]`);
        (el.querySelector('input,button') || el).click();
      }, layer.id).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
    }
    const failed = report.filter((r) => r.problems.length);
    console.log(`\n${failed.length} of ${report.length} layers reported problems`);
    process.exitCode = failed.length ? 1 : 0;
  }
} finally {
  await browser.close();
}
