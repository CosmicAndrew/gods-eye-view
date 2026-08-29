#!/usr/bin/env node
/**
 * qa-voice-session — does the GEV MIC button reach a live Realtime session?
 *
 * Drives the real voice control with a fake microphone: clicks the mic, then
 * watches the panel's own status/error surfaces and the WebRTC connection
 * state. Proves the whole path end to end - ephemeral token, SDP exchange,
 * ICE, data channel - which probing /api/realtime/token cannot: that endpoint
 * returns 200 whether or not the account can actually open a session.
 *
 * Usage: node scripts/qa-voice-session.mjs [--url http://localhost:4173] [--watch 40000]
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const url = arg('--url', 'http://localhost:4173');
const watchMs = Number(arg('--watch', '40000'));

const chromePath = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

const browser = await puppeteer.launch({
  headless: false,
  ...(chromePath ? { executablePath: chromePath } : {}),
  args: [
    '--force-high-performance-gpu',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await browser.defaultBrowserContext().overridePermissions(new URL(url).origin, ['microphone']);

  // --auth user:pass, for a deployment behind the basic-auth gate.
  const auth = arg('--auth', null);
  if (auth) {
    const [username, ...rest] = auth.split(':');
    await page.authenticate({ username, password: rest.join(':') });
  }

  const voiceLogs = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/realtime|sdp|ice|voice|mic|webrtc|session/i.test(t)) voiceLogs.push(`${m.type()}: ${t.slice(0, 200)}`);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#gev-voice-button', { timeout: 60000 });

  // Record peer connections without replacing the constructor: patching it
  // outright broke the app's own construction path on the first attempt.
  await page.evaluate(() => {
    window.__gevPcs = [];
    const create = RTCPeerConnection.prototype.createOffer;
    RTCPeerConnection.prototype.createOffer = function (...a) {
      if (!window.__gevPcs.includes(this)) window.__gevPcs.push(this);
      return create.apply(this, a);
    };
  });

  // Can the page get a mic at all? A hang here is an environment fault, not the app's.
  const micProbe = await page.evaluate(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const n = s.getAudioTracks().length;
      s.getTracks().forEach((t) => t.stop());
      return `ok (${n} audio track(s))`;
    } catch (e) { return `FAILED: ${e.name}: ${e.message}`; }
  });
  console.error(`[mic probe] ${micProbe}`);

  const before = await page.evaluate(() => document.getElementById('gev-voice-status')?.textContent?.trim());
  await page.click('#gev-voice-button');

  const deadline = Date.now() + watchMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      // Only a tray carrying text is a real error; it lives in the DOM always.
      const errText = document.getElementById('gev-voice-error-detail')?.textContent?.trim() || '';
      const pc = window.__gevPcs?.[window.__gevPcs.length - 1] ?? null;
      return {
        status: document.getElementById('gev-voice-status')?.textContent?.trim() ?? null,
        dataStatus: document.getElementById('gev-voice-control')?.dataset?.status ?? null,
        detail: document.getElementById('gev-voice-detail')?.textContent?.trim() ?? null,
        cost: document.getElementById('gev-voice-cost-value')?.textContent?.trim() ?? null,
        error: errText || null,
        pc: pc ? { conn: pc.connectionState, ice: pc.iceConnectionState, sig: pc.signalingState } : null,
      };
    });
    if (last.error) break;
    if (last.pc?.conn === 'connected') break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const verdict = last?.error ? 'FAIL' : last?.pc?.conn === 'connected' ? 'PASS' : 'INCONCLUSIVE';
  console.log(JSON.stringify({ verdict, statusBefore: before, ...last, voiceLogs: voiceLogs.slice(-12) }, null, 2));
  process.exitCode = verdict === 'PASS' ? 0 : 1;
} finally {
  await browser.close();
}
