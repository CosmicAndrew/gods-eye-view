#!/usr/bin/env node
/**
 * qa-gpu-matrix — find a Chrome GPU configuration that starts reliably.
 *
 * On a hybrid-graphics machine whose discrete driver has been restarted but
 * not cleanly re-initialised, Chrome's GPU process hangs on some launches and
 * works on others. A single run cannot tell those apart, so this repeats each
 * flag combination and reports adapter, frame rate, and hang rate.
 *
 * Usage: node scripts/qa-gpu-matrix.mjs [--url ...] [--auth user:pass] [--runs 3]
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const url = arg('--url', 'http://localhost:4173');
const auth = arg('--auth', null);
const runs = Number(arg('--runs', '3'));

const chromePath = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

const CONFIGS = [
  { name: 'd3d11 (default)', args: ['--force-high-performance-gpu'] },
  { name: 'd3d11 + ignore-blocklist', args: ['--force-high-performance-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] },
  { name: 'angle=d3d11on12', args: ['--force-high-performance-gpu', '--use-angle=d3d11on12'] },
  { name: 'angle=vulkan', args: ['--force-high-performance-gpu', '--use-angle=vulkan'] },
  { name: 'angle=gl', args: ['--force-high-performance-gpu', '--use-angle=gl'] },
];

async function attempt(extraArgs) {
  const browser = await puppeteer.launch({
    headless: false,
    ...(chromePath ? { executablePath: chromePath } : {}),
    protocolTimeout: 45_000,
    args: [...extraArgs, '--window-size=1440,900'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    if (auth) {
      const [username, ...rest] = auth.split(':');
      await page.authenticate({ username, password: rest.join(':') });
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => Boolean(document.querySelector('.cesium-widget canvas')), { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 9000));

    const renderer = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const gl = c?.getContext('webgl2') || c?.getContext('webgl');
      const d = gl?.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    const fps = await page.evaluate(() => new Promise((resolve) => {
      let f = 0; const t0 = performance.now();
      const tick = () => { f++; if (performance.now() - t0 < 4000) requestAnimationFrame(tick); else resolve(+(f / ((performance.now() - t0) / 1000)).toFixed(1)); };
      requestAnimationFrame(tick);
    }));
    return { ok: true, gpu: /NVIDIA/i.test(renderer) ? 'NVIDIA' : /Intel/i.test(renderer) ? 'Intel' : renderer.slice(0, 30), fps };
  } catch (e) {
    return { ok: false, reason: e.message.slice(0, 40) };
  } finally {
    await browser.close().catch(() => {});
  }
}

for (const config of CONFIGS) {
  const results = [];
  for (let i = 0; i < runs; i++) results.push(await attempt(config.args));
  const good = results.filter((r) => r.ok);
  const nvidia = good.filter((r) => r.gpu === 'NVIDIA');
  const avg = nvidia.length ? (nvidia.reduce((s, r) => s + r.fps, 0) / nvidia.length).toFixed(1) : '-';
  console.log(
    `${config.name.padEnd(26)} ok=${good.length}/${runs}  nvidia=${nvidia.length}/${runs}  avgFps=${avg}`
    + (good.length < runs ? `  [${results.filter((r) => !r.ok).length} hung]` : ''),
  );
}
