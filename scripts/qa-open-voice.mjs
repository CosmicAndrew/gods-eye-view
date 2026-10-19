#!/usr/bin/env node
/**
 * Open-source voice acceptance: a spoken WAV in, a camera move out.
 *
 * Serve the app with GEV_VOICE_ENGINE=open, then:
 *   node scripts/qa-open-voice.mjs http://localhost:4190 [wav]
 *
 * Chromium plays the WAV as its microphone (looped). The run passes when Whisper's
 * transcript reaches /api/voice/open/respond, a fly_to_location call comes
 * back, and the camera ends up over Paris. Like every fake-device harness this
 * says nothing about a real microphone (see CLAUDE.md hazard 5).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = new URL(process.argv[2] || 'http://localhost:4190');
target.searchParams.set('welcome', '0');
const wavPath = process.argv[3] || path.join(repoRoot, 'scripts', 'fixtures', 'voice', 'open-fly-to-paris.wav');
if (!fs.existsSync(wavPath)) {
  console.error(`WAV fixture not found: ${wavPath}`);
  process.exit(2);
}
const PARIS = { lat: 48.8566, lon: 2.3522 };
const TIMEOUT_MS = Number(process.env.QA_OPEN_VOICE_TIMEOUT_MS || 420_000);

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: [process.env.QA_CHROME, await puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe']
    .find((candidate) => candidate && fs.existsSync(candidate)),
  args: [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavPath}`,
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-webgpu',
    // Hardware GPU in headless mode; without these WebGPU is SwiftShader.
    '--enable-gpu',
    '--use-angle=d3d11',
    '--ignore-gpu-blocklist',
    '--window-size=1280,800',
  ],
});

const log = [];
const note = (line) => {
  const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
  log.push(stamped);
  console.log(stamped);
};

let exitCode = 1;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // The basic-auth gate arms whenever .env carries credentials.
  const envFile = path.join(repoRoot, '.env');
  const dotenv = fs.existsSync(envFile)
    ? Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]))
    : {};
  const username = process.env.GEV_AUTH_USER || dotenv.GEV_AUTH_USER;
  const password = process.env.GEV_AUTH_PASSWORD || dotenv.GEV_AUTH_PASSWORD;
  if (username && password) await page.authenticate({ username, password });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // onnxruntime logs its CPU fallback for shape ops as an error; it is not.
    if (message.type() === 'error' && !message.text().includes('[W:onnxruntime'))
      errors.push(message.text());
  });
  const turns = [];
  // Which voice spoke, from the local server's debug log (same machine only).
  const debugLogFile = path.join(repoRoot, '.gev-logs', 'realtime-conversations.jsonl');
  const startedAt = new Date().toISOString();
  const spokenSince = () => {
    const spoke = {};
    if (!fs.existsSync(debugLogFile)) return spoke;
    for (const line of fs.readFileSync(debugLogFile, 'utf8').split('\n')) {
      if (!line.includes('open_voice.spoke')) continue;
      try {
        const record = JSON.parse(line);
        if ((record.timestamp || '') >= startedAt) spoke[record.payload?.voice] = (spoke[record.payload?.voice] || 0) + 1;
      } catch { /* partial line */ }
    }
    return spoke;
  };
  page.on('response', (response) => {
    const url = response.url();
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${url.slice(0, 140)}`);
  });
  page.on('response', async (response) => {
    if (!response.url().includes('/api/voice/open/respond')) return;
    const request = JSON.parse(response.request().postData() || '{}');
    const body = await response.json().catch(() => null);
    const lastUser = [...(request.messages || [])].reverse().find((m) => m.role === 'user')?.content;
    turns.push({ status: response.status(), lastUser, body });
    note(`respond ${response.status()} via ${body?.provider || '-'}; heard "${lastUser}"; ` +
      `tools ${JSON.stringify((body?.message?.tool_calls || []).map((c) => `${c.name}${c.arguments}`))}; ` +
      `says "${(body?.message?.content || '').slice(0, 80)}"`);
  });

  if (process.env.QA_OPEN_VOICE_DEVICE) {
    await page.evaluateOnNewDocument((device) => {
      try { localStorage.setItem('godsEyeView.openVoice.device', device); } catch { /* storage blocked */ }
    }, process.env.QA_OPEN_VOICE_DEVICE);
  }
  await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => (
    window.__godsEyeView?.voiceCommands
    && document.getElementById('gev-voice-button')
    && document.getElementById('loading-screen')?.classList.contains('hidden')
  ), { timeout: 120_000 });
  note('app ready; starting voice');
  await page.click('#gev-voice-button');

  const deadline = Date.now() + TIMEOUT_MS;
  let lastDetail = '';
  let arrived = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const carto = window.__godsEyeView?.viewer?.camera?.positionCartographic;
      return {
        status: document.getElementById('gev-voice-control')?.dataset?.status || null,
        detail: document.getElementById('gev-voice-detail')?.textContent?.trim() || '',
        lat: carto ? (carto.latitude * 180) / Math.PI : null,
        lon: carto ? (carto.longitude * 180) / Math.PI : null,
      };
    });
    const detail = `${state.status}: ${state.detail}`;
    if (detail !== lastDetail) {
      note(`voice ${detail}`);
      lastDetail = detail;
    }
    if (state.status === 'error') break;
    if (state.lat !== null && Math.abs(state.lat - PARIS.lat) < 1 && Math.abs(state.lon - PARIS.lon) < 1.5) {
      note(`camera over Paris (${state.lat.toFixed(3)}, ${state.lon.toFixed(3)})`);
      arrived = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const flew = turns.some((turn) => turn.body?.message?.tool_calls?.some((call) => call.name === 'fly_to_location'));
  const heard = turns.some((turn) => /paris/i.test(turn.lastUser || ''));
  // Give the spoken confirmation time to synthesize, then see which voice spoke.
  // QA_OPEN_VOICE_SOAK_MS keeps the looped WAV running for more turns, so
  // steady-state synthesis times are measured, not just the first reply.
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.QA_OPEN_VOICE_SOAK_MS || 0)));
  const speakDeadline = Date.now() + 90_000;
  const waitFrom = Date.now();
  while (Date.now() < speakDeadline) {
    if (Object.keys(spokenSince()).length) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  note(`first spoken chunk after ${((Date.now() - waitFrom) / 1000).toFixed(1)}s of waiting`);
  for (const line of fs.existsSync(debugLogFile) ? fs.readFileSync(debugLogFile, 'utf8').split('\n') : []) {
    if (!/open_voice\.(tts\.failed|tts\.late|spoke)/.test(line)) continue;
    try {
      const record = JSON.parse(line);
      if ((record.timestamp || '') >= startedAt) note(`${record.event}: ${JSON.stringify(record.payload)}`);
    } catch { /* partial line */ }
  }
  const spoke = spokenSince();
  note(`spoken chunks by voice: ${JSON.stringify(spoke)}`);
  note(`heard Paris: ${heard}; fly_to_location returned: ${flew}; camera arrived: ${arrived}`);
  if (errors.length) note(`page errors:\n  ${errors.slice(0, 8).join('\n  ')}`);
  exitCode = heard && flew && arrived ? 0 : 1;
  note(exitCode === 0 ? 'PASS' : 'FAIL');
} finally {
  await browser.close();
}
process.exit(exitCode);
