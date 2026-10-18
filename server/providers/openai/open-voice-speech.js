import { readRequestBody } from '../common/request.js';
import { enforceRateLimit } from './rate-limit.js';
import { makeCostRateLimiter } from '../common/rate-limit.js';

/**
 * Open voice: hosted speech recognition and speech synthesis.
 *
 * The browser posts a 16 kHz WAV utterance to /transcribe (Groq Whisper) and a
 * reply sentence to /speak, which tries each synthesis provider in
 * GEV_VOICE_TTS_PROVIDERS order (Fish Audio, then Chatterbox on DeepInfra) and
 * returns the first audio that comes back. Keys stay server-side.
 */

const STT = {
  keyEnv: 'GROQ_API_KEY',
  url: 'https://api.groq.com/openai/v1/audio/transcriptions',
  model: 'whisper-large-v3-turbo',
  modelEnv: 'GEV_VOICE_STT_MODEL',
};

const TTS_PROVIDERS = {
  fish: {
    keyEnv: 'FISH_API_KEY',
    request: (text, key) => ({
      url: 'https://api.fish.audio/v1/tts',
      headers: { Authorization: `Bearer ${key}`, model: process.env.GEV_VOICE_FISH_MODEL || 's2-pro' },
      body: {
        text,
        format: 'mp3',
        latency: 'balanced',
        ...(process.env.GEV_VOICE_FISH_VOICE_ID ? { reference_id: process.env.GEV_VOICE_FISH_VOICE_ID } : {}),
      },
    }),
  },
  deepinfra: {
    keyEnv: 'DEEPINFRA_API_KEY',
    request: (text, key) => ({
      url: 'https://api.deepinfra.com/v1/openai/audio/speech',
      headers: { Authorization: `Bearer ${key}` },
      body: {
        model: process.env.GEV_VOICE_DEEPINFRA_MODEL || 'ResembleAI/chatterbox-turbo',
        input: text,
        response_format: 'mp3',
        ...(process.env.GEV_VOICE_DEEPINFRA_VOICE ? { voice: process.env.GEV_VOICE_DEEPINFRA_VOICE } : {}),
      },
    }),
  },
};

const DEFAULT_TTS_ORDER = ['fish', 'deepinfra'];
const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // about two minutes of 16 kHz mono PCM
const MAX_TEXT_CHARS = 1200;
const SPEECH_DEFAULT_PER_MIN = 120;

const hasKey = (env, name) => Boolean(String(env[name] ?? '').trim());

/** Synthesis providers to try, in GEV_VOICE_TTS_PROVIDERS order, that have a key set. */
function configuredTtsProviders(environment = process.env) {
  const listed = String(environment.GEV_VOICE_TTS_PROVIDERS || '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return (listed.length ? listed : DEFAULT_TTS_ORDER).filter(
    (name) => TTS_PROVIDERS[name] && hasKey(environment, TTS_PROVIDERS[name].keyEnv),
  );
}

function hostedSttConfigured(environment = process.env) {
  return hasKey(environment, STT.keyEnv);
}

let _limiter;
function speechRateLimiter() {
  if (_limiter === undefined)
    _limiter = makeCostRateLimiter(process.env.GEV_RATELIMIT_OPEN_VOICE_SPEECH_PER_MIN, SPEECH_DEFAULT_PER_MIN);
  return _limiter;
}

function answer(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** The raw request body, or null once it passes `limit` bytes. */
function readBinaryBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** POST audio/wav → { text }. */
async function handleOpenVoiceTranscribe(req, res) {
  if (req.method !== 'POST') return answer(res, 405, { error: 'Method not allowed' });
  if (!hostedSttConfigured()) return answer(res, 503, { error: 'No speech recognition key is set' });
  if (!enforceRateLimit(speechRateLimiter(), req, res)) return undefined;
  const audio = await readBinaryBody(req, MAX_AUDIO_BYTES).catch(() => null);
  // A RIFF header is 44 bytes; anything shorter carries no speech.
  if (!audio || audio.length <= 44 || audio.subarray(0, 4).toString('ascii') !== 'RIFF')
    return answer(res, 400, { error: 'Malformed audio' });
  const form = new FormData();
  form.append('model', process.env[STT.modelEnv] || STT.model);
  form.append('language', 'en');
  form.append('response_format', 'json');
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'utterance.wav');
  try {
    const response = await fetch(STT.url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${process.env[STT.keyEnv]}` },
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data?.text !== 'string') {
      console.warn(`[open-voice] transcribe upstream HTTP ${response.status}`);
      return answer(res, 502, { error: 'Speech recognition failed' });
    }
    return answer(res, 200, { text: data.text });
  } catch {
    console.warn('[open-voice] transcribe request failed');
    return answer(res, 502, { error: 'Speech recognition failed' });
  }
}

/** POST { text } → audio/mpeg, with X-GEV-TTS-Provider naming who spoke. */
async function handleOpenVoiceSpeak(req, res) {
  if (req.method !== 'POST') return answer(res, 405, { error: 'Method not allowed' });
  const providers = configuredTtsProviders();
  if (!providers.length) return answer(res, 503, { error: 'No speech synthesis key is set' });
  if (!enforceRateLimit(speechRateLimiter(), req, res)) return undefined;
  let text;
  try {
    text = JSON.parse((await readRequestBody(req, 16 * 1024)) || 'null')?.text;
  } catch {
    return answer(res, 400, { error: 'Malformed speech request' });
  }
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_CHARS)
    return answer(res, 400, { error: 'Malformed speech request' });

  for (const name of providers) {
    const { url, headers, body } = TTS_PROVIDERS[name].request(text.trim(), process.env[TTS_PROVIDERS[name].keyEnv]);
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const type = response.headers.get('content-type') || '';
      if (!response.ok || !type.startsWith('audio/')) {
        await response.body?.cancel?.().catch(() => {});
        console.warn(`[open-voice] ${name} speak upstream HTTP ${response.status}`);
        continue;
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (!audio.length) continue;
      res.statusCode = 200;
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-GEV-TTS-Provider', name);
      return res.end(audio);
    } catch {
      console.warn(`[open-voice] ${name} speak request failed`);
    }
  }
  return answer(res, 502, { error: 'Speech synthesis failed' });
}

export {
  configuredTtsProviders,
  handleOpenVoiceSpeak,
  handleOpenVoiceTranscribe,
  hostedSttConfigured,
};
