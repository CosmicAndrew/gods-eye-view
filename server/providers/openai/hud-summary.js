import {
  HUD_SUMMARY_INSTRUCTIONS,
  keylessHudSummaryResponse,
} from '../../../src/hudSummaryResponse.js';
import { enforceRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { OPENAI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';

function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

function extractChatCompletionText(data) {
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

/** OpenAI-compatible chat-completions fallbacks for an OpenAI key that cannot pay. */
const CHAT_PROVIDERS = {
  gemini: {
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEV_HUD_SUMMARY_GEMINI_MODEL',
    model: 'gemini-2.5-flash-lite',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  },
  deepseek: {
    keyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'GEV_HUD_SUMMARY_DEEPSEEK_MODEL',
    model: 'deepseek-chat',
    url: 'https://api.deepseek.com/chat/completions',
  },
  openrouter: {
    keyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'GEV_HUD_SUMMARY_OPENROUTER_MODEL',
    model: 'google/gemini-2.5-flash-lite',
    url: 'https://openrouter.ai/api/v1/chat/completions',
  },
};

const DEFAULT_PROVIDER_ORDER = ['openai', 'gemini', 'deepseek', 'openrouter'];

/** Providers to try, in GEV_HUD_SUMMARY_PROVIDERS order, that have a key set. */
function configuredProviders(environment = process.env) {
  const listed = String(environment.GEV_HUD_SUMMARY_PROVIDERS || '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const order = listed.length ? listed : DEFAULT_PROVIDER_ORDER;
  return order.filter((name) => {
    const keyEnv = name === 'openai' ? 'OPENAI_API_KEY' : CHAT_PROVIDERS[name]?.keyEnv;
    return keyEnv && String(environment[keyEnv] ?? '').trim();
  });
}

function requestSummary(name, input) {
  if (name === 'openai') {
    return {
      url: 'https://api.openai.com/v1/responses',
      key: process.env.OPENAI_API_KEY,
      body: {
        model:
          process.env.OPENAI_HUD_SUMMARY_MODEL ||
          OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
        instructions: HUD_SUMMARY_INSTRUCTIONS,
        input,
        reasoning: { effort: 'minimal' },
        max_output_tokens: 100,
      },
      extract: extractOpenAiResponseText,
    };
  }
  const provider = CHAT_PROVIDERS[name];
  return {
    url: provider.url,
    key: process.env[provider.keyEnv],
    body: {
      model: process.env[provider.modelEnv] || provider.model,
      messages: [
        { role: 'system', content: HUD_SUMMARY_INSTRUCTIONS },
        { role: 'user', content: input },
      ],
      max_tokens: 40,
    },
    extract: extractChatCompletionText,
  };
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

async function handleHudSummary(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const providers = configuredProviders();
  const keyless = keylessHudSummaryResponse(providers.join(','));
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  // Per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). On by default; 0 disables.
  // Keyless HUD fallback has no provider cost and resolves above without
  // consuming a paid-endpoint quota slot.
  if (!enforceRateLimit(openAiRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, 64 * 1024);
    const input = JSON.stringify(JSON.parse(body || '{}'));
    let response;
    let summary = '';
    // A refused or empty answer hands the same request to the next provider,
    // so one account out of credit does not blank the HUD.
    for (const name of providers) {
      const call = requestSummary(name, input);
      response = await fetch(call.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${call.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(call.body),
      }).catch(() => ({ ok: false, status: 502, json: async () => ({}) }));
      const data = await response.json().catch(() => ({}));
      summary = response.ok ? toFiveWordHudSummary(call.extract(data)) : '';
      if (summary) break;
      console.warn(`[hud-summary] ${name} upstream HTTP ${response.status}`);
    }
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        summary: summary || null,
        // Never relay `data.error.message`: that is OpenAI's own wording, and
        // it carries request ids, organization hints and quota phrasing.
        error: response.ok ? null : 'OpenAI HUD summary request failed',
      }),
    );
  } catch {
    console.warn('[hud-summary] request failed');
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'OpenAI HUD summary request failed',
      }),
    );
  }
}

export { handleHudSummary };
