#!/usr/bin/env node
/**
 * qa-fps-under-load — frame rate doing what a user actually does.
 *
 * The boot smoke test measures a parked camera over a nearly empty scene and
 * reports 60fps while the app stutters in use. This turns layers on, flies the
 * camera, and samples during the motion, which is where "glitchy" lives. It
 * also reports the slowest frames, because a 45fps average made of one 300ms
 * stall reads as broken while a steady 45fps does not.
 *
 * Usage: node scripts/qa-fps-under-load.mjs [--url ...] [--auth u:p] [--gpu] [--layers n]
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const url = arg('--url', 'http://localhost:4173');
const auth = arg('--auth', null);
const layerCount = Number(arg('--layers', '5'));
const forceGpu = argv.includes('--gpu');

const chromePath = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

const browser = await puppeteer.launch({
  headless: false,
  ...(chromePath ? { executablePath: chromePath } : {}),
  protocolTimeout: 180_000,
  args: [...(forceGpu ? ['--force-high-performance-gpu'] : []), '--window-size=1440,900'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  if (auth) {
    const [username, ...rest] = auth.split(':');
    await page.authenticate({ username, password: rest.join(':') });
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => Boolean(document.querySelector('.cesium-widget canvas')), { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 10000)); // let the intro flight finish

  const enabled = await page.evaluate((n) => {
    const toggles = [...document.querySelectorAll('#data-toggles [data-layer-id]')].slice(0, n);
    for (const el of toggles) (el.querySelector('input,button') || el).click();
    return toggles.map((el) => el.getAttribute('data-layer-id'));
  }, layerCount);
  await new Promise((r) => setTimeout(r, 12000)); // let those layers populate

  const renderer = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const gl = c?.getContext('webgl2') || c?.getContext('webgl');
    const d = gl?.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });

  // Sample frame intervals while the camera is actually moving.
  const stats = await page.evaluate(() => new Promise((resolve) => {
    const cam = window.viewer?.camera;
    const gaps = [];
    let last = performance.now();
    const t0 = last;
    const tick = () => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      cam?.rotateRight?.(0.002);
      if (now - t0 < 8000) requestAnimationFrame(tick);
      else {
        gaps.sort((a, b) => a - b);
        const at = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
        resolve({
          frames: gaps.length,
          fps: +(gaps.length / ((now - t0) / 1000)).toFixed(1),
          medianMs: +at(0.5).toFixed(1),
          p95Ms: +at(0.95).toFixed(1),
          worstMs: +gaps[gaps.length - 1].toFixed(1),
          stallsOver100ms: gaps.filter((g) => g > 100).length,
        });
      }
    };
    requestAnimationFrame(tick);
  }));

  console.log(JSON.stringify({
    gpu: /NVIDIA/i.test(renderer) ? 'NVIDIA' : /Intel/i.test(renderer) ? 'Intel' : renderer.slice(0, 40),
    layersEnabled: enabled,
    ...stats,
  }, null, 2));
} finally {
  await browser.close();
}
