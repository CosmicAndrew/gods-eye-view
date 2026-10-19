#!/usr/bin/env node
/**
 * qa-boot-smoke — does the app actually boot on this machine?
 *
 * Loads the running server, waits for the Cesium viewer to exist, and reports
 * console errors, failed requests, and which data layers registered. Works
 * against the dev server or a production preview build; unlike the deeper
 * harnesses it needs no `import.meta.env.DEV` QA hooks, so it is the one check
 * that is valid against `npm run preview`.
 *
 * Usage: node scripts/qa-boot-smoke.mjs [--url http://localhost:4173] [--headful] [--settle 20000]
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback);
const url = arg('--url', 'http://localhost:4173');
const settleMs = Number(arg('--settle', '20000'));
const headful = argv.includes('--headful');

/** Prefer an installed Chrome over puppeteer's download, which this machine lacks. */
const chromePath = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

// On a hybrid-graphics laptop Chrome picks the integrated GPU by default.
const gpuArgs = argv.includes('--force-gpu') ? ['--force-high-performance-gpu'] : [];

const browser = await puppeteer.launch({
  headless: !headful,
  ...(chromePath ? { executablePath: chromePath } : {}),
  // The frame-rate probe blocks its execution context for a full sampling
  // window, which outruns the 30s default and aborts the run.
  protocolTimeout: 180_000,
  args: headful
    ? gpuArgs
    : ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', ...gpuArgs],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  const auth = arg('--auth', null);
  if (auth) {
    const [username, ...rest] = auth.split(':');
    await page.authenticate({ username, password: rest.join(':') });
  }

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 300)));
  page.on('requestfailed', (r) => failedRequests.push(`${r.failure()?.errorText} ${r.url().slice(0, 120)}`));
  const badResponses = [];
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url().replace(/key=[^&]+/, 'key=REDACTED').slice(0, 140)}`);
  });

  const started = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const viewerReady = await page
    .waitForFunction(() => Boolean(window.__godsEyeView?.viewer?.scene) || Boolean(document.querySelector('.cesium-widget canvas')), { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  const readyMs = Date.now() - started;

  await new Promise((r) => setTimeout(r, settleMs));

  const state = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      title: document.title,
      canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl ? 'masked' : 'no-webgl'),
      layerToggles: document.querySelectorAll('#data-toggles [data-layer-id], #data-toggles button, #data-toggles input').length,
      voiceControl: Boolean(document.getElementById('gev-voice-control')),
      voiceButton: Boolean(document.getElementById('gev-voice-button')),
      voiceStatus: document.getElementById('gev-voice-status')?.textContent?.trim() ?? null,
      primitives: window.__godsEyeView?.viewer?.scene?.primitives?.length ?? null,
      entities: window.__godsEyeView?.viewer?.entities?.values?.length ?? null,
      // Which globe is actually on screen. Keyless boot falls back to Esri
      // imagery rather than throwing when the baked Google key is missing or
      // rejected, so a build with no key still boots, still passes every other
      // check here, and renders a completely different scene. Without this a
      // frame-rate or layer run can compare two different maps and call it a
      // regression.
      mapStack: window.__godsEyeView?.mapStackController?.getState?.()?.activeId ?? null,
    };
  });

  // Frame rate over a 5s window at rest.
  const fps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => { frames++; if (performance.now() - t0 < 5000) requestAnimationFrame(tick); else resolve(+(frames / ((performance.now() - t0) / 1000)).toFixed(1)); };
    requestAnimationFrame(tick);
  }));

  console.log(JSON.stringify({
    url, viewerReady, readyMs, fps, ...state,
    consoleErrors: [...new Set(consoleErrors)].slice(0, 15),
    pageErrors: [...new Set(pageErrors)].slice(0, 10),
    failedRequests: [...new Set(failedRequests)].slice(0, 15),
    badResponses: [...new Set(badResponses)].slice(0, 20),
  }, null, 2));

  // Not a failure — keyless boot is a supported mode upstream — but it must be
  // impossible to miss, because every other line of this report looks healthy
  // while the globe on screen is not the one the deployment ships.
  if (state.mapStack && state.mapStack !== 'photoreal') {
    console.error(
      `[warn] map stack is "${state.mapStack}", not "photoreal": the Google 3D tileset did not load.\n`
      + '       The app booted on fallback imagery, so any frame-rate or layer number from this\n'
      + '       run describes a different scene and must not be compared with a photoreal run.',
    );
  }

  process.exitCode = viewerReady && pageErrors.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
