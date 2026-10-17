/**
 * The HUD summary must survive an OpenAI account that cannot pay.
 *
 * On 2026-10-16 the deployment's OpenAI key answered every request with 429
 * `credit_balance_exhausted`, so the HUD line went blank while Gemini,
 * DeepSeek and OpenRouter keys sat unused. A refused provider now hands the
 * same request to the next configured one (OpenAI-compatible chat
 * completions), in GEV_HUD_SUMMARY_PROVIDERS order.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleHudSummary } from '../../server/providers/openai/hud-summary.js';

const KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'GEV_HUD_SUMMARY_PROVIDERS', 'GEV_RATELIMIT_OPENAI_PER_MIN'];

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

function post(remoteAddress) {
  return new Promise((resolve) => {
    const headers = {};
    const req = {
      method: 'POST',
      headers: {},
      socket: { remoteAddress },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"place":"Paris"}'); },
      on(event, fn) {
        if (event === 'data') fn(Buffer.from('{"place":"Paris"}'));
        if (event === 'end') fn();
        return this;
      },
    };
    const res = {
      statusCode: 200,
      setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
      end: (body) => resolve({ status: res.statusCode, json: JSON.parse(body) }),
    };
    handleHudSummary(req, res);
  });
}

test('an exhausted OpenAI key falls through to the next provider', async (t) => {
  setEnv(t, { OPENAI_API_KEY: 'sk-fixture', GEMINI_API_KEY: 'gm-fixture' });
  const hosts = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    hosts.push(new URL(url).host);
    if (url.includes('openai.com')) return Response.json({ error: { code: 'credit_balance_exhausted' } }, { status: 429 });
    assert.equal(init.headers.Authorization, 'Bearer gm-fixture');
    return Response.json({ choices: [{ message: { content: 'Paris river night live view' } }] });
  });
  const reply = await post('10.20.0.1');
  assert.deepEqual(hosts, ['api.openai.com', 'generativelanguage.googleapis.com']);
  assert.equal(reply.status, 200);
  assert.equal(reply.json.summary, 'Paris river night live view');
});

test('no OpenAI key at all still summarizes from another provider', async (t) => {
  setEnv(t, { DEEPSEEK_API_KEY: 'ds-fixture' });
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /api\.deepseek\.com/);
    return Response.json({ choices: [{ message: { content: 'Paris quiet streets five words' } }] });
  });
  const reply = await post('10.20.0.2');
  assert.equal(reply.json.summary, 'Paris quiet streets five words');
});

test('GEV_HUD_SUMMARY_PROVIDERS sets the order and skips unlisted providers', async (t) => {
  setEnv(t, { OPENAI_API_KEY: 'sk', GEMINI_API_KEY: 'gm', OPENROUTER_API_KEY: 'or', GEV_HUD_SUMMARY_PROVIDERS: 'openrouter,gemini' });
  const hosts = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    hosts.push(new URL(url).host);
    return Response.json({ choices: [{ message: { content: 'one two three four five' } }] });
  });
  await post('10.20.0.3');
  assert.deepEqual(hosts, ['openrouter.ai']);
});

test('every provider failing reports the generic error, no upstream wording', async (t) => {
  setEnv(t, { OPENAI_API_KEY: 'sk', GEMINI_API_KEY: 'gm' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'req_leak_123' } }, { status: 503 }));
  const reply = await post('10.20.0.4');
  assert.equal(reply.status, 503);
  assert.equal(reply.json.error, 'OpenAI HUD summary request failed');
  assert.equal(JSON.stringify(reply.json).includes('req_leak'), false);
});

test('no key anywhere is still the free unconfigured answer', async (t) => {
  setEnv(t, {});
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no provider may be called'));
  const reply = await post('10.20.0.5');
  assert.equal(reply.json.configured, false);
});
