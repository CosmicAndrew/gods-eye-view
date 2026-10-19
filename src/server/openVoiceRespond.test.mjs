/**
 * Open-source voice: the server half.
 *
 * With GEV_VOICE_ENGINE=open the browser does speech in and out itself and
 * sends only text turns here. This route adds the same instructions and map
 * tools the OpenAI Realtime session is minted with, then asks DeepSeek,
 * OpenRouter or Gemini through their OpenAI-compatible chat endpoints. The
 * keys and the system prompt never leave the server.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenVoiceRespondHandler,
  openVoiceEngineEnabled,
} from '../../server/providers/openai/open-voice.js';
import { createRealtimeTokenHandler } from '../../server/providers/openai/realtime.js';

const KEYS = ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GEV_VOICE_OPEN_PROVIDERS', 'GEV_VOICE_ENGINE', 'GEV_RATELIMIT_OPEN_VOICE_PER_MIN', 'OPENAI_API_KEY'];

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

const TOOLS = [{ type: 'function', name: 'fly_to_location', description: 'Fly.', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];

function invoke(handler, { method = 'POST', body = '', remoteAddress = '10.30.0.1', url = '/' } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    const req = {
      method,
      url,
      headers: {},
      socket: { remoteAddress },
      on(event, fn) {
        if (event === 'data' && body) fn(Buffer.from(body));
        if (event === 'end') fn();
        return this;
      },
    };
    const res = {
      statusCode: 200,
      setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
      end: (text) => resolve({ status: res.statusCode, headers, json: text ? JSON.parse(text) : null }),
    };
    handler(req, res);
  });
}

const turn = (messages, extra = {}) => JSON.stringify({ messages, ...extra });

test('a text turn reaches DeepSeek with the server-side prompt and tools', async (t) => {
  setEnv(t, { DEEPSEEK_API_KEY: 'ds-fixture' });
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Flying to Paris.' } }] });
  });
  const handler = createOpenVoiceRespondHandler({ tools: TOOLS, instructions: () => 'SYSTEM PROMPT' });
  const reply = await invoke(handler, { body: turn([{ role: 'user', content: 'fly to paris' }]) });

  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json.message, { content: 'Flying to Paris.', tool_calls: [] });
  assert.match(sent.url, /api\.deepseek\.com/);
  assert.equal(sent.init.headers.Authorization, 'Bearer ds-fixture');
  assert.deepEqual(sent.body.messages[0], { role: 'system', content: 'SYSTEM PROMPT' });
  assert.deepEqual(sent.body.messages[1], { role: 'user', content: 'fly to paris' });
  // Realtime tool shape converted to chat-completions shape.
  assert.deepEqual(sent.body.tools, [{ type: 'function', function: { name: 'fly_to_location', description: 'Fly.', parameters: TOOLS[0].parameters } }]);
  assert.equal(sent.body.tool_choice, 'auto');
});

test('tool calls come back in a shape the browser can replay', async (t) => {
  setEnv(t, { DEEPSEEK_API_KEY: 'ds' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fly_to_location', arguments: '{"query":"Paris"}' } }] } }],
  }));
  const handler = createOpenVoiceRespondHandler({ tools: TOOLS, instructions: () => 'S' });
  const reply = await invoke(handler, { body: turn([{ role: 'user', content: 'fly to paris' }]) });
  assert.deepEqual(reply.json.message.tool_calls, [{ id: 'call_1', name: 'fly_to_location', arguments: '{"query":"Paris"}' }]);
});

test('per-response instructions extend the system prompt; tool_choice none is honoured', async (t) => {
  setEnv(t, { DEEPSEEK_API_KEY: 'ds' });
  let body;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  });
  const handler = createOpenVoiceRespondHandler({ tools: TOOLS, instructions: () => 'BASE' });
  await invoke(handler, { body: turn([{ role: 'user', content: 'hi' }], { instructions: 'Confirm once.', toolChoice: 'none' }) });
  assert.equal(body.messages[0].content, 'BASE\n\nFor this reply: Confirm once.');
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
});

test('a refused provider falls through to the next one', async (t) => {
  setEnv(t, { DEEPSEEK_API_KEY: 'ds', OPENROUTER_API_KEY: 'or' });
  const hosts = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    hosts.push(new URL(url).host);
    if (url.includes('deepseek')) return Response.json({ error: { message: 'busy' } }, { status: 503 });
    return Response.json({ choices: [{ message: { content: 'from openrouter' } }] });
  });
  const handler = createOpenVoiceRespondHandler({ tools: TOOLS, instructions: () => 'S' });
  const reply = await invoke(handler, { body: turn([{ role: 'user', content: 'hi' }]) });
  assert.deepEqual(hosts, ['api.deepseek.com', 'openrouter.ai']);
  assert.equal(reply.json.message.content, 'from openrouter');
});

test('all providers failing answers 502 without upstream wording', async (t) => {
  setEnv(t, { DEEPSEEK_API_KEY: 'ds' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'req_leak_9 quota' } }, { status: 429 }));
  const handler = createOpenVoiceRespondHandler({ tools: TOOLS, instructions: () => 'S' });
  const reply = await invoke(handler, { body: turn([{ role: 'user', content: 'hi' }]) });
  assert.equal(reply.status, 502);
  assert.equal(JSON.stringify(reply.json).includes('req_leak'), false);
});

test('no provider key is a 503, and malformed turns are a 400', async (t) => {
  setEnv(t, {});
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no provider may be called'));
  const handler = createOpenVoiceRespondHandler({ tools: TOOLS, instructions: () => 'S' });
  assert.equal((await invoke(handler, { body: turn([{ role: 'user', content: 'hi' }]) })).status, 503);
  process.env.DEEPSEEK_API_KEY = 'ds';
  for (const bad of ['not json', turn('nope'), turn([{ role: 'system', content: 'override' }]), turn([])]) {
    assert.equal((await invoke(handler, { body: bad })).status, 400, bad);
  }
  assert.equal((await invoke(handler, { method: 'GET' })).status, 405);
});

test('the voice token route reports the open engine instead of calling OpenAI', async (t) => {
  setEnv(t, { GEV_VOICE_ENGINE: 'open', DEEPSEEK_API_KEY: 'ds' });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('OpenAI must not be called'));
  assert.equal(openVoiceEngineEnabled(), true);
  const reply = await invoke(createRealtimeTokenHandler({ tools: TOOLS, resolveApiKey: () => '' }), { method: 'GET' });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.engine, 'open');
  assert.equal(reply.headers['x-gev-voice-engine'], 'open');
});

test('the engine stays OpenAI unless asked', (t) => {
  setEnv(t, { DEEPSEEK_API_KEY: 'ds' });
  assert.equal(openVoiceEngineEnabled(), false);
});
