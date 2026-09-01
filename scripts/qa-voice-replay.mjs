#!/usr/bin/env node
/**
 * qa-voice-replay — replay the launch demo's spoken commands and record what
 * the agent actually calls.
 *
 * The demo (youtu.be/GRJaKcXZS94) is the spec for what voice is supposed to do.
 * Several of its requests are COMPOUND - "turn on CCTV and annotate the outline
 * and annotate the compound", "annotate LAX and DFW and tell me the distance" -
 * and in the video the agent confirms only the first clause. This drives the
 * real session over the data channel with the same phrasing and prints the
 * function calls, so "it dropped the rest" is measured rather than inferred.
 *
 * Text is injected instead of audio deliberately: it isolates intent handling
 * from speech recognition, so a miss here is the model's plan, not a mishearing.
 *
 * Usage: node scripts/qa-voice-replay.mjs [--url ...] [--auth u:p] [--only N]
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const argv = process.argv;
const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const url = arg('--url', 'http://localhost:4173');
const auth = arg('--auth', null);
const only = arg('--only', null);

/** Verbatim from the demo, with the clauses each one is supposed to satisfy. */
const COMMANDS = [
  {
    say: 'Take me to the Texas State Capitol in Austin, Texas and start orbiting around it.',
    expect: ['fly_to_location', 'move_camera'],
  },
  {
    say: 'Can you turn on the CCTV layer and also annotate the Texas State Capitol building outline? And maybe also annotate the compound as well.',
    expect: ['set_layer_visibility|control_cctv', 'annotate_map', 'annotate_map'],
  },
  {
    say: 'Annotate LAX and Dallas Fort Worth and tell me the relative distance between them.',
    expect: ['annotate_map', 'annotate_map', 'spoken-distance'],
  },
  {
    say: 'Take me out to a globe view and then annotate the state of Texas and the state of California.',
    expect: ['zoom_to_globe', 'annotate_map', 'annotate_map'],
  },
  {
    say: 'Take me to China and turn on the dams layer.',
    expect: ['fly_to_location', 'set_layer_visibility'],
  },
];

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

  // Capture the data channel so we can both inject text and read the replies.
  await page.evaluateOnNewDocument(() => {
    window.__gevDc = null;
    window.__gevEvents = [];
    const native = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const channel = native.apply(this, args);
      window.__gevDc = channel;
      channel.addEventListener('message', (event) => {
        try { window.__gevEvents.push(JSON.parse(event.data)); } catch { /* non-JSON */ }
      });
      return channel;
    };
  });

  // Which network call fails is the whole question when a resolve reports
  // "could not pinpoint" while every upstream answers fine from the shell.
  const net = [];
  page.on('requestfailed', (r) => {
    const t = r.failure()?.errorText || '';
    if (!t.includes('ERR_ABORTED')) net.push(`FAILED ${t} ${r.url().replace(/key=[^&]+/, 'key=***').slice(0, 120)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) net.push(`HTTP ${r.status()} ${r.url().replace(/key=[^&]+/, 'key=***').slice(0, 120)}`);
  });
  page.on('console', (m) => {
    const t = m.text();
    // The resolver logs its verdict, including the proximity-gate rejection
    // that silently turns a valid place name into "nothing could be marked".
    if (m.type() === 'error' || t.includes('[Resolver]')) net.push(`console: ${t.slice(0, 200)}`);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('#gev-voice-button', { timeout: 90000 });
  await page.click('#gev-voice-button');
  await page.waitForFunction(
    () => document.getElementById('gev-voice-control')?.dataset?.status === 'listening',
    { timeout: 90000 },
  );
  await new Promise((r) => setTimeout(r, 2500));

  // --order lets a run reproduce the demo's actual sequence. Resolution is
  // viewport-biased, so "annotate LAX" cold is not the same request the demo
  // made right after framing the United States.
  const order = arg('--order', null);
  const chosen = order
    ? order.split(',').map((n) => COMMANDS[Number(n.trim()) - 1]).filter(Boolean)
    : only ? [COMMANDS[Number(only) - 1]].filter(Boolean) : COMMANDS;

  for (const [i, cmd] of chosen.entries()) {
    const mark = await page.evaluate(() => window.__gevEvents.length);

    await page.evaluate((text) => {
      const dc = window.__gevDc;
      dc.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      }));
      dc.send(JSON.stringify({ type: 'response.create' }));
    }, cmd.say);

    // Wait for the model to finish this turn.
    await page.waitForFunction(
      (from) => window.__gevEvents.slice(from).some((e) => e.type === 'response.done'),
      { timeout: 90000 }, mark,
    ).catch(() => {});

    // A navigation tool can defer its follow-up until arrival, so the turn is
    // not over at response.done. Wait for the channel to actually go quiet -
    // sending the next command early produced "active response in progress"
    // and attributed one turn's calls to the next.
    let last = -1;
    for (let quiet = 0; quiet < 12;) {
      const n = await page.evaluate(() => window.__gevEvents.length);
      quiet = n === last ? quiet + 1 : 0;
      last = n;
      await new Promise((r) => setTimeout(r, 1000));
    }

    const turn = await page.evaluate((from) => {
      const events = window.__gevEvents.slice(from);
      return {
        calls: events.filter((e) => e.type === 'response.function_call_arguments.done')
          .map((e) => `${e.name}(${(e.arguments || '').replace(/\s+/g, ' ').slice(0, 70)})`),
        said: events.filter((e) => e.type === 'response.output_audio_transcript.done')
          .map((e) => e.transcript).join(' ').trim(),
        errors: events.filter((e) => e.type === 'error').map((e) => e.error?.message || 'error'),
      };
    }, mark);

    console.log(`\n${'─'.repeat(72)}`);
    console.log(`${i + 1}. "${cmd.say}"`);
    console.log(`   expected : ${cmd.expect.join(' + ')}`);
    console.log(`   called   : ${turn.calls.length ? turn.calls.join('  ') : '(none)'}`);
    console.log(`   said     : ${turn.said || '(nothing)'}`);
    if (turn.errors.length) console.log(`   errors   : ${turn.errors.join('; ')}`);
    const seen = [...new Set(net)];
    for (const n of seen) console.log(`   network  : ${n}`);
    net.length = 0;
  }
  console.log(`\n${'─'.repeat(72)}`);
} finally {
  await browser.close();
}
