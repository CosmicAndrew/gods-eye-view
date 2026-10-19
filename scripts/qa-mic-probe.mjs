#!/usr/bin/env node
/**
 * qa-mic-probe — is the real microphone actually producing audio?
 *
 * The voice harnesses use --use-fake-device-for-media-stream, which bypasses
 * the OS entirely: they prove the Realtime session works while saying nothing
 * about whether this machine's microphone is delivering samples. This opens
 * each audio input for real and measures peak deviation from silence, so a
 * dead mic is distinguishable from a broken app.
 *
 * Usage: node scripts/qa-mic-probe.mjs [--url ...] [--auth user:pass] [--seconds 3]
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const url = arg('--url', 'http://localhost:4173');
const auth = arg('--auth', null);
const seconds = Number(arg('--seconds', '3'));

const chromePath = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

const browser = await puppeteer.launch({
  headless: false,
  ...(chromePath ? { executablePath: chromePath } : {}),
  args: ['--use-fake-ui-for-media-stream'], // grants Chrome's prompt; OS-level consent is separate
});

try {
  const page = await browser.newPage();
  if (auth) {
    const [username, ...rest] = auth.split(':');
    await page.authenticate({ username, password: rest.join(':') });
  }
  await browser.defaultBrowserContext().overridePermissions(new URL(url).origin, ['microphone']);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

  const results = await page.evaluate(async (secs) => {
    const measure = async (deviceId) => {
      const stream = await navigator.mediaDevices.getUserMedia(
        deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true },
      );
      const track = stream.getAudioTracks()[0];
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let peak = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < secs * 1000) {
        analyser.getByteTimeDomainData(buf);
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        await new Promise((r) => setTimeout(r, 50));
      }
      const info = { label: track.label, muted: track.muted, state: track.readyState, peak };
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      return info;
    };

    const out = [];
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    for (const device of devices) {
      try {
        out.push(await measure(device.deviceId));
      } catch (e) {
        out.push({ label: device.label, error: `${e.name}: ${e.message}` });
      }
    }
    return out;
  }, seconds);

  for (const r of results) {
    // peak is 0-127 deviation from the 128 silence midpoint; anything under ~2
    // is indistinguishable from a dead line.
    const verdict = r.error ? 'ERROR' : r.peak >= 2 ? 'HEARS AUDIO' : 'SILENT';
    console.log(`${verdict.padEnd(12)} peak=${String(r.peak ?? '-').padStart(4)} muted=${r.muted ?? '-'}  ${r.label || '(no label)'}${r.error ? `  ${r.error}` : ''}`);
  }
  process.exitCode = results.some((r) => !r.error && r.peak >= 2) ? 0 : 1;
} finally {
  await browser.close();
}
