#!/usr/bin/env node
/**
 * qa-voice-heard — does OpenAI actually hear us, and does it act?
 *
 * qa-voice-session proves the WebRTC session connects. That is not the same as
 * the model receiving audio: a session can sit in LISTENING forever while the
 * microphone feeds silence. This taps the Realtime data channel and prints the
 * events OpenAI sends back - speech detection, transcripts, and function calls -
 * so a failure can be located at capture, transcription, or dispatch.
 *
 * The fixture is LOOPED on purpose. qa-voice-wav.mjs feeds it with `%noloop`,
 * and the session needs ~15s to reach LISTENING, by which point a ~9s clip has
 * already played to nobody.
 *
 * Usage:
 *   node scripts/qa-voice-heard.mjs [--url http://localhost:4173] [--auth user:pass]
 *                                   [--wav path] [--watch 60000]
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv;
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const url = arg('--url', 'http://localhost:4173');
const wav = path.resolve(arg('--wav', path.join(here, 'fixtures/voice/full-globe-turn-on-radio.wav')));
const watchMs = Number(arg('--watch', '60000'));
const auth = arg('--auth', null);

if (!existsSync(wav)) throw new Error(`fixture not found: ${wav}`);

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
    `--use-file-for-fake-audio-capture=${wav}`, // looped: see header
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await browser.defaultBrowserContext().overridePermissions(new URL(url).origin, ['microphone']);
  if (auth) {
    const [username, ...rest] = auth.split(':');
    await page.authenticate({ username, password: rest.join(':') });
  }

  // Tap the Realtime data channel before the app opens one.
  await page.evaluateOnNewDocument(() => {
    window.__gevEvents = [];
    window.__gevAudioSent = null;
    const nativeCreate = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const channel = nativeCreate.apply(this, args);
      channel.addEventListener('message', (event) => {
        try {
          const parsed = JSON.parse(event.data);
          window.__gevEvents.push(parsed);
        } catch { /* non-JSON frame */ }
      });
      return channel;
    };
    // Confirm a live audio track is actually being sent upstream.
    const nativeAddTrack = RTCPeerConnection.prototype.addTrack;
    RTCPeerConnection.prototype.addTrack = function (track, ...rest) {
      if (track?.kind === 'audio') {
        window.__gevAudioSent = { enabled: track.enabled, muted: track.muted, state: track.readyState, label: track.label };
      }
      return nativeAddTrack.call(this, track, ...rest);
    };
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('#gev-voice-button', { timeout: 90000 });
  await page.click('#gev-voice-button');

  await page.waitForFunction(
    () => document.getElementById('gev-voice-control')?.dataset?.status === 'listening',
    { timeout: 90000 },
  ).catch(() => console.error('[warn] never reached LISTENING'));

  const deadline = Date.now() + watchMs;
  let seen = 0;
  while (Date.now() < deadline) {
    const n = await page.evaluate(() => window.__gevEvents.length);
    if (n !== seen) {
      const fresh = await page.evaluate((from) => window.__gevEvents.slice(from).map((e) => e.type), seen);
      for (const t of fresh) console.error(`  event: ${t}`);
      seen = n;
    }
    const done = await page.evaluate(() =>
      window.__gevEvents.some((e) => e.type === 'response.function_call_arguments.done' || e.type === 'response.done'));
    if (done) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const result = await page.evaluate(() => {
    const events = window.__gevEvents;
    const byType = {};
    for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
    return {
      audioTrackSent: window.__gevAudioSent,
      speechDetected: events.some((e) => e.type === 'input_audio_buffer.speech_started'),
      transcripts: events
        .filter((e) => e.type === 'conversation.item.input_audio_transcription.completed')
        .map((e) => e.transcript),
      functionCalls: events
        .filter((e) => e.type === 'response.function_call_arguments.done')
        .map((e) => ({ name: e.name, args: e.arguments })),
      errors: events.filter((e) => e.type === 'error').map((e) => e.error?.message || JSON.stringify(e).slice(0, 200)),
      eventCounts: byType,
      voiceStatus: document.getElementById('gev-voice-control')?.dataset?.status,
      radioEnabled: Boolean(document.querySelector('[data-layer-id="radio"] input:checked')),
    };
  });

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.speechDetected ? 0 : 1;
} finally {
  await browser.close();
}
