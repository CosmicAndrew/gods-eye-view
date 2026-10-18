/**
 * Open voice: hosted speech in and out.
 *
 * /api/voice/open/transcribe forwards a WAV utterance to Groq Whisper and
 * /api/voice/open/speak tries Fish Audio, then Chatterbox on DeepInfra, and
 * returns the first audio. Keys stay server-side; upstream wording never
 * reaches the browser.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configuredTtsProviders,
  handleOpenVoiceSpeak,
  handleOpenVoiceTranscribe,
} from '../../server/providers/openai/open-voice-speech.js';

const KEYS = ['GROQ_API_KEY', 'FISH_API_KEY', 'FAL_KEY', 'DEEPINFRA_API_KEY', 'GEV_VOICE_TTS_PROVIDERS', 'GEV_VOICE_FISH_VOICE_ID'];

function setEnv(t, values) {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

let nextAddress = 0;
function invoke(handler, { method = 'POST', body = '' } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    const req = {
      method,
      url: '/',
      headers: {},
      // A fresh address per call keeps the shared rate limiter out of the way.
      socket: { remoteAddress: `10.40.${Math.floor(nextAddress / 250)}.${(nextAddress++ % 250) + 1}` },
      on(event, fn) {
        if (event === 'data' && body.length) fn(Buffer.from(body));
        if (event === 'end') fn();
        return this;
      },
    };
    const res = {
      statusCode: 200,
      setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
      end: (data) => {
        const isJson = String(headers['content-type'] || '').startsWith('application/json');
        resolve({ status: res.statusCode, headers, json: isJson ? JSON.parse(data) : null, raw: data });
      },
    };
    handler(req, res);
  });
}

const wav = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(200)]);
const audioResponse = (bytes = 'ID3audio') =>
  new Response(Buffer.from(bytes), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });

test('an utterance reaches Groq Whisper turbo and the transcript comes back', async (t) => {
  setEnv(t, { GROQ_API_KEY: 'gsk-fixture' });
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent = { url, init };
    return Response.json({ text: ' Fly to Paris', x_groq: { id: 'req_x' } });
  });
  const reply = await invoke(handleOpenVoiceTranscribe, { body: wav() });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json, { text: ' Fly to Paris' });
  assert.equal(sent.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(sent.init.headers.Authorization, 'Bearer gsk-fixture');
  assert.equal(sent.init.body.get('model'), 'whisper-large-v3-turbo');
  assert.equal(sent.init.body.get('file').size, 204);
});

test('transcribe refuses non-WAV bodies and answers 503 with no key', async (t) => {
  setEnv(t, { GROQ_API_KEY: 'gsk-fixture' });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no upstream call expected'));
  assert.equal((await invoke(handleOpenVoiceTranscribe, { body: 'not audio at all, just some text bytes here please' })).status, 400);
  assert.equal((await invoke(handleOpenVoiceTranscribe, { method: 'GET' })).status, 405);
  delete process.env.GROQ_API_KEY;
  assert.equal((await invoke(handleOpenVoiceTranscribe, { body: wav() })).status, 503);
});

test('transcribe hides upstream wording behind a generic 502', async (t) => {
  setEnv(t, { GROQ_API_KEY: 'gsk-fixture' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'quota for org_123' } }, { status: 429 }));
  const reply = await invoke(handleOpenVoiceTranscribe, { body: wav() });
  assert.equal(reply.status, 502);
  assert.doesNotMatch(JSON.stringify(reply.json), /org_123/);
});

test('speak uses Fish Audio S2 Pro first and names the provider', async (t) => {
  setEnv(t, { FISH_API_KEY: 'fish-fixture', DEEPINFRA_API_KEY: 'di-fixture' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return audioResponse();
  });
  const reply = await invoke(handleOpenVoiceSpeak, { body: JSON.stringify({ text: 'Flying to Paris.' }) });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['content-type'], 'audio/mpeg');
  assert.equal(reply.headers['x-gev-tts-provider'], 'fish');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.fish.audio/v1/tts');
  assert.equal(calls[0].init.headers.model, 's2-pro');
  assert.equal(calls[0].body.text, 'Flying to Paris.');
});

test('speak falls through to Chatterbox when Fish is out of credit', async (t) => {
  setEnv(t, { FISH_API_KEY: 'fish-fixture', DEEPINFRA_API_KEY: 'di-fixture' });
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    urls.push(url);
    if (url.includes('fish.audio')) return Response.json({ status: 402, message: 'Insufficient API credit' }, { status: 402 });
    assert.equal(JSON.parse(init.body).model, 'ResembleAI/chatterbox-turbo');
    return audioResponse();
  });
  const reply = await invoke(handleOpenVoiceSpeak, { body: JSON.stringify({ text: 'Hello.' }) });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['x-gev-tts-provider'], 'deepinfra');
  assert.equal(urls.length, 2);
});

test('speak treats a 200 that is not audio as a failure', async (t) => {
  setEnv(t, { DEEPINFRA_API_KEY: 'di-fixture' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  const reply = await invoke(handleOpenVoiceSpeak, { body: JSON.stringify({ text: 'Hello.' }) });
  assert.equal(reply.status, 502);
});

test('speak validates text and honours GEV_VOICE_TTS_PROVIDERS', async (t) => {
  setEnv(t, { FISH_API_KEY: 'f', DEEPINFRA_API_KEY: 'd', GEV_VOICE_TTS_PROVIDERS: 'deepinfra,fish,nope' });
  assert.deepEqual(configuredTtsProviders(), ['deepinfra', 'fish']);
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no upstream call expected'));
  assert.equal((await invoke(handleOpenVoiceSpeak, { body: JSON.stringify({ text: '  ' }) })).status, 400);
  assert.equal((await invoke(handleOpenVoiceSpeak, { body: JSON.stringify({ text: 'x'.repeat(1201) }) })).status, 400);
  assert.equal((await invoke(handleOpenVoiceSpeak, { body: '{bad' })).status, 400);
  for (const key of ['FISH_API_KEY', 'DEEPINFRA_API_KEY']) delete process.env[key];
  assert.equal((await invoke(handleOpenVoiceSpeak, { body: JSON.stringify({ text: 'Hi.' }) })).status, 503);
});

test('speak reaches ElevenLabs v4 on fal after Fish and fetches the hosted file', async (t) => {
  setEnv(t, { FISH_API_KEY: 'fish-fixture', FAL_KEY: 'fal-fixture', DEEPINFRA_API_KEY: 'di-fixture' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('fish.audio')) return Response.json({ status: 402 }, { status: 402 });
    if (url === 'https://fal.run/elevenlabs/tts/eleven-v4') {
      assert.equal(init.headers.Authorization, 'Key fal-fixture');
      assert.equal(JSON.parse(init.body).text, 'Hello.');
      return Response.json({ audio: { url: 'https://v3.fal.media/files/x/speech.mp3' } });
    }
    if (url === 'https://v3.fal.media/files/x/speech.mp3') return audioResponse();
    assert.fail(`unexpected ${url}`);
  });
  const reply = await invoke(handleOpenVoiceSpeak, { body: JSON.stringify({ text: 'Hello.' }) });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['x-gev-tts-provider'], 'fal');
  assert.equal(calls.length, 3);
});

test('a fal answer without an https audio file falls through to Chatterbox', async (t) => {
  setEnv(t, { FAL_KEY: 'fal-fixture', DEEPINFRA_API_KEY: 'di-fixture' });
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.startsWith('https://fal.run/')) return Response.json({ audio: { url: 'http://insecure.example/a.mp3' } });
    if (url.includes('deepinfra')) return audioResponse();
    assert.fail(`unexpected ${url}`);
  });
  const reply = await invoke(handleOpenVoiceSpeak, { body: JSON.stringify({ text: 'Hello.' }) });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['x-gev-tts-provider'], 'deepinfra');
});
