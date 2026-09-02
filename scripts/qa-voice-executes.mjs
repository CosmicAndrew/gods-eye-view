#!/usr/bin/env node
/**
 * qa-voice-executes — does the app DO what the spoken command asks?
 *
 * Every other voice harness here stops at the tool CALL: it reads
 * response.function_call_arguments.done off the data channel and calls that
 * success. That only proves the model DECIDED to act. It does not prove the app
 * executed — the camera actually flew, the layer actually toggled. "It does not
 * do what I ask" lives in exactly that gap.
 *
 * So this feeds REAL audio (not injected text) through the fake-microphone
 * device, snapshots the real app state before and after via window.__godsEyeView,
 * and reports three things per command: was the tool called, did the world
 * change, and did they agree. A called tool with no world change is the bug.
 *
 * The fixture is LOOPED: the session needs ~15s to reach LISTENING and a clip
 * played once (%noloop) is gone by then.
 *
 * Usage: node scripts/qa-voice-executes.mjs [--url ...] [--auth u:p]
 *        [--wav scripts/fixtures/voice/full-globe-turn-on-radio.wav] [--watch 45000]
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv;
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const url = arg('--url', 'http://localhost:4173');
const auth = arg('--auth', null);
const wav = path.resolve(arg('--wav', path.join(here, 'fixtures/voice/full-globe-turn-on-radio.wav')));
const watchMs = Number(arg('--watch', '45000'));

if (!existsSync(wav)) throw new Error(`fixture not found: ${wav}`);

const chromePath = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p));

const browser = await puppeteer.launch({
  headless: false,
  ...(chromePath ? { executablePath: chromePath } : {}),
  protocolTimeout: 180_000,
  args: [
    '--force-high-performance-gpu',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`, // looped — real audio, not text
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900',
  ],
});

/** The real app state that a "full globe, turn on radio" command should change. */
const SNAPSHOT = () => {
  const g = window.__godsEyeView;
  const cam = g?.viewer?.camera?.positionCartographic;
  const radio = g?.dataManager?.layers?.get('radio')?.module?.getUIState?.() || null;
  return {
    cameraHeightM: cam?.height ?? null,
    radioEnabled: radio?.enabled ?? null,
    radioStation: radio?.selected?.name || null,
    annotationCount: g?.annotations?.count?.() ?? g?.annotations?.list?.()?.length ?? null,
  };
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await browser.defaultBrowserContext().overridePermissions(new URL(url).origin, ['microphone']);
  if (auth) {
    const [username, ...rest] = auth.split(':');
    await page.authenticate({ username, password: rest.join(':') });
  }

  await page.evaluateOnNewDocument(() => {
    window.__gevEvents = [];
    const native = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const ch = native.apply(this, args);
      ch.addEventListener('message', (e) => { try { window.__gevEvents.push(JSON.parse(e.data)); } catch { /* */ } });
      return ch;
    };
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  // Wait on the canvas (reliable) then poll for the global — on a cold Cloud Run
  // instance the viewer can take well past a single 90s window to initialize.
  await page.waitForFunction(() => document.querySelector('.cesium-widget canvas'), { timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.dataManager?.layers?.get?.('radio')),
    { timeout: 120000, polling: 1000 });
  await page.waitForSelector('#gev-voice-button', { timeout: 90000 });

  const before = await page.evaluate(SNAPSHOT);
  await page.click('#gev-voice-button');
  await page.waitForFunction(
    () => document.getElementById('gev-voice-control')?.dataset?.status === 'listening',
    { timeout: 90000 },
  ).catch(() => console.error('[warn] never reached LISTENING'));

  const deadline = Date.now() + watchMs;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => window.__gevEvents.some((e) => e.type === 'response.done'));
    if (done) { await new Promise((r) => setTimeout(r, 4000)); break; } // let the action settle
    await new Promise((r) => setTimeout(r, 1000));
  }

  const after = await page.evaluate(SNAPSHOT);
  const calls = await page.evaluate(() => window.__gevEvents
    .filter((e) => e.type === 'response.function_call_arguments.done')
    .map((e) => ({ name: e.name, args: e.arguments })));
  const heardSpeech = await page.evaluate(() => window.__gevEvents.some((e) => e.type === 'input_audio_buffer.speech_started'));
  const errors = await page.evaluate(() => window.__gevEvents.filter((e) => e.type === 'error').map((e) => e.error?.message));

  const called = (n) => calls.some((c) => c.name === n);
  const globe = { name: 'zoom_to_globe', called: called('zoom_to_globe'),
    executed: Number(after.cameraHeightM) >= 8_000_000 && Number(after.cameraHeightM) > Number(before.cameraHeightM || 0) };
  const radio = { name: 'control_radio', called: called('control_radio'),
    executed: after.radioEnabled === true && before.radioEnabled !== true };

  const verdict = (c) => c.called && c.executed ? 'PASS'
    : c.called && !c.executed ? 'CALLED-BUT-NOT-EXECUTED'
    : !c.called && c.executed ? 'EXECUTED-WITHOUT-CALL'
    : 'NEITHER';

  console.log(JSON.stringify({
    command: 'spoken: "full globe, turn on radio"',
    heardSpeech,
    toolCalls: calls.map((c) => c.name),
    before, after,
    zoom_to_globe: verdict(globe),
    control_radio: verdict(radio),
    errors: [...new Set(errors)].filter(Boolean),
  }, null, 2));

  const ok = verdict(globe) === 'PASS' && verdict(radio) === 'PASS';
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
