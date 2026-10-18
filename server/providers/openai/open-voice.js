import { readRequestBody } from '../common/request.js';
import { enforceRateLimit } from './rate-limit.js';
import { makeCostRateLimiter } from '../common/rate-limit.js';

/**
 * Open-source voice: text turns for the browser-side speech pipeline.
 *
 * With GEV_VOICE_ENGINE=open the browser runs speech recognition and speech
 * synthesis itself (src/voice/openVoice/) and sends only the conversation as
 * text. This route adds the same instructions and map tools an OpenAI Realtime
 * session is minted with and asks an OpenAI-compatible chat endpoint, so the
 * provider keys and the system prompt stay server-side exactly as they do for
 * the Realtime token.
 */

const PROVIDERS = {
  deepseek: {
    keyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'GEV_VOICE_OPEN_DEEPSEEK_MODEL',
    model: 'deepseek-chat',
    url: 'https://api.deepseek.com/chat/completions',
  },
  openrouter: {
    keyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'GEV_VOICE_OPEN_OPENROUTER_MODEL',
    model: 'qwen/qwen3-235b-a22b-2507',
    url: 'https://openrouter.ai/api/v1/chat/completions',
  },
  gemini: {
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEV_VOICE_OPEN_GEMINI_MODEL',
    model: 'gemini-2.5-flash',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  },
};

const DEFAULT_ORDER = ['deepseek', 'openrouter', 'gemini'];
const MAX_MESSAGES = 200;
const MAX_BODY_BYTES = 512 * 1024;
const OPEN_VOICE_DEFAULT_PER_MIN = 60;

/** Whether the deployment asked for the open-source voice engine. */
function openVoiceEngineEnabled(environment = process.env) {
  return String(environment.GEV_VOICE_ENGINE || '').trim().toLowerCase() === 'open';
}

/** Providers to try, in GEV_VOICE_OPEN_PROVIDERS order, that have a key set. */
function configuredOpenVoiceProviders(environment = process.env) {
  const listed = String(environment.GEV_VOICE_OPEN_PROVIDERS || '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return (listed.length ? listed : DEFAULT_ORDER).filter(
    (name) => PROVIDERS[name] && String(environment[PROVIDERS[name].keyEnv] ?? '').trim(),
  );
}

let _limiter;
function openVoiceRateLimiter() {
  if (_limiter === undefined)
    _limiter = makeCostRateLimiter(
      process.env.GEV_RATELIMIT_OPEN_VOICE_PER_MIN,
      OPEN_VOICE_DEFAULT_PER_MIN,
    );
  return _limiter;
}

/** Realtime `{type,name,description,parameters}` tools as chat-completions tools. */
function toChatTools(tools) {
  return tools.map(({ name, description, parameters }) => ({
    type: 'function',
    function: { name, description, parameters },
  }));
}

/**
 * Validate the browser's turns and convert them to chat messages. Only user,
 * assistant and tool roles are accepted: the system prompt is the server's.
 * Returns null for anything malformed.
 */
function toChatMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES)
    return null;
  const out = [];
  for (const message of messages) {
    const role = message?.role;
    const content = message?.content ?? null;
    if (content !== null && typeof content !== 'string') return null;
    if (role === 'user') {
      if (!content) return null;
      out.push({ role, content });
    } else if (role === 'assistant') {
      const calls = message.tool_calls ?? [];
      if (!Array.isArray(calls)) return null;
      const toolCalls = [];
      for (const call of calls) {
        if (typeof call?.id !== 'string' || typeof call?.name !== 'string') return null;
        toolCalls.push({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: String(call.arguments ?? '{}') },
        });
      }
      if (!content && !toolCalls.length) return null;
      out.push({ role, content: content || '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else if (role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || content === null) return null;
      out.push({ role, tool_call_id: message.tool_call_id, content });
    } else {
      return null;
    }
  }
  return out;
}

function answer(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * POST { messages, instructions?, toolChoice? } → { message: { content, tool_calls } }.
 * @param {{ tools: object[], instructions: () => string }} options
 */
function createOpenVoiceRespondHandler({ tools, instructions }) {
  const chatTools = toChatTools(tools);
  return async (req, res) => {
    if (req.method !== 'POST') return answer(res, 405, { error: 'Method not allowed' });
    const providers = configuredOpenVoiceProviders();
    if (!providers.length)
      return answer(res, 503, { error: 'No open voice provider key is set' });
    if (!enforceRateLimit(openVoiceRateLimiter(), req, res)) return undefined;

    let turn;
    try {
      turn = JSON.parse((await readRequestBody(req, MAX_BODY_BYTES)) || 'null');
    } catch {
      return answer(res, 400, { error: 'Malformed voice turn' });
    }
    const messages = toChatMessages(turn?.messages);
    if (!messages) return answer(res, 400, { error: 'Malformed voice turn' });
    const extra = typeof turn.instructions === 'string' ? turn.instructions.trim().slice(0, 4000) : '';
    const system = extra ? `${instructions()}\n\nFor this reply: ${extra}` : instructions();
    const withTools = turn.toolChoice !== 'none';

    for (const name of providers) {
      const provider = PROVIDERS[name];
      try {
        const response = await fetch(provider.url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(45_000),
          headers: {
            Authorization: `Bearer ${process.env[provider.keyEnv]}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: process.env[provider.modelEnv] || provider.model,
            messages: [{ role: 'system', content: system }, ...messages],
            ...(withTools ? { tools: chatTools, tool_choice: 'auto' } : {}),
            max_tokens: 600,
          }),
        });
        const data = await response.json().catch(() => ({}));
        const message = data?.choices?.[0]?.message;
        if (!response.ok || !message) {
          console.warn(`[open-voice] ${name} upstream HTTP ${response.status}`);
          continue;
        }
        const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
          .filter((call) => call?.function?.name)
          .map((call, index) => ({
            id: String(call.id || `call_${Date.now().toString(36)}_${index}`),
            name: call.function.name,
            arguments: String(call.function.arguments || '{}'),
          }));
        return answer(res, 200, {
          provider: name,
          message: { content: typeof message.content === 'string' ? message.content : '', tool_calls: toolCalls },
        });
      } catch {
        console.warn(`[open-voice] ${name} request failed`);
      }
    }
    // Never relay upstream wording: it carries request ids and quota phrasing.
    return answer(res, 502, { error: 'Open voice request failed' });
  };
}

export {
  configuredOpenVoiceProviders,
  createOpenVoiceRespondHandler,
  openVoiceEngineEnabled,
};
