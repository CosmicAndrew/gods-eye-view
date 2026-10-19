/**
 * Open-source voice: a local stand-in for the OpenAI Realtime data channel.
 *
 * The voice controller speaks the Realtime event protocol over a data channel
 * (`conversation.item.create`, `response.create`, `response.done`, ...). This
 * peer accepts those client events and produces the same server events from a
 * browser speech pipeline (speech in, speech out) and a text model behind
 * /api/voice/open/respond, so turn handling, tool dispatch, narration and the
 * HUD run unchanged on either engine.
 *
 * Only the events the client consumes are emitted. No `usage` is reported:
 * the cost meter prices OpenAI tokens and this engine is billed elsewhere.
 */

const MAX_CHAT_MESSAGES = 60;
const MISSING_TOOL_OUTPUT = JSON.stringify({
  ok: false,
  error: 'No result was returned for this call.',
});

let sequence = 0;
const nextId = (prefix) =>
  `${prefix}_open_${Date.now().toString(36)}_${(++sequence).toString(36)}`;

function partsText(content, { includeTranscripts = true } = {}) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (
        part?.type === 'input_text' ||
        part?.type === 'output_text' ||
        part?.type === 'text'
      )
        return part.text || '';
      if (
        includeTranscripts &&
        (part?.type === 'input_audio' || part?.type === 'output_audio')
      )
        return part.transcript || '';
      return ''; // images: the text models behind this engine cannot read them
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Realtime conversation items → chat-completions turns for the server route.
 *
 * Tool outputs are placed directly after the assistant message that called
 * them, wherever the client appended them: providers reject a conversation in
 * which anything sits between a tool call and its result, and the client does
 * insert viewport context there. A call with no output yet gets a placeholder
 * for the same reason. The window is trimmed to start on a user turn.
 */
export function toChatTurns(items, { maxMessages = MAX_CHAT_MESSAGES } = {}) {
  const outputs = new Map();
  for (const item of items)
    if (item?.type === 'function_call_output' && item.call_id)
      outputs.set(item.call_id, String(item.output ?? ''));

  const turns = [];
  let toolTurn = null; // the assistant message collecting one response's calls
  for (const item of items) {
    if (item?.type === 'function_call') {
      if (!toolTurn || toolTurn.responseId !== item.response_id) {
        const last = turns.at(-1);
        toolTurn =
          last?.role === 'assistant' &&
          last.responseId === item.response_id &&
          !last.tool_calls
            ? last
            : { role: 'assistant', content: '', responseId: item.response_id };
        if (toolTurn !== last) turns.push(toolTurn);
        toolTurn.tool_calls = [];
        toolTurn.results = [];
      }
      toolTurn.tool_calls.push({
        id: item.call_id,
        name: item.name,
        arguments: String(item.arguments ?? '{}'),
      });
      toolTurn.results.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: outputs.get(item.call_id) ?? MISSING_TOOL_OUTPUT,
      });
      continue;
    }
    if (toolTurn) {
      turns.push(...toolTurn.results);
      toolTurn = null;
    }
    if (item?.type !== 'message') continue;
    const text = partsText(item.content).trim();
    if (!text) continue;
    if (item.role === 'assistant')
      turns.push({
        role: 'assistant',
        content: text,
        responseId: item.response_id,
      });
    else if (item.role === 'user') turns.push({ role: 'user', content: text });
    else if (item.role === 'system')
      // The server owns the system prompt; app context travels as a labelled user turn.
      turns.push({
        role: 'user',
        content: `App context (not spoken by the operator): ${text}`,
      });
  }
  if (toolTurn) turns.push(...toolTurn.results);

  let window = turns.slice(-maxMessages);
  const firstUser = window.findIndex((turn) => turn.role === 'user');
  window = firstUser < 0 ? [] : window.slice(firstUser);
  return window.map(({ responseId, results, ...turn }) => turn);
}

/**
 * @param {{
 *   respond: (turn: {messages: object[], instructions?: string, toolChoice?: string}, options: {signal: AbortSignal}) => Promise<{content: string, tool_calls: {id: string, name: string, arguments: string}[]}>,
 *   speech: { speak: (text: string, options: {signal: AbortSignal}) => Promise<void>, stop: () => void },
 * }} options
 */
export function createOpenVoicePeer({ respond, speech }) {
  const target = new EventTarget();
  const items = [];
  let readyState = 'connecting';
  let active = null; // the in-band response: { id, controller }
  let pendingAutoResponse = false;
  let userItemId = null;
  let speaking = Promise.resolve();

  const emit = (event) => {
    if (readyState !== 'open') return;
    const payload = { event_id: nextId('event'), ...event };
    target.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(payload) }),
    );
  };
  const emitError = (code, message, eventId) =>
    emit({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code,
        message,
        event_id: eventId || null,
      },
    });

  /** Queue playback after any line already speaking, as one audio stream would. */
  function play(responseId, text, signal) {
    speaking = speaking.then(async () => {
      if (signal.aborted || readyState !== 'open') return;
      emit({ type: 'output_audio_buffer.started', response_id: responseId });
      try {
        await speech.speak(text, { signal });
      } catch {
        /* a failed line ends like a finished one */
      }
      emit({ type: 'output_audio_buffer.stopped', response_id: responseId });
    });
    return speaking;
  }

  function finish(response, status, output = [], details) {
    if (active?.id === response.id) active = null;
    emit({
      type: 'response.done',
      response: {
        id: response.id,
        object: 'realtime.response',
        status,
        output,
        metadata: response.metadata ?? null,
        ...(details ? { status_details: details } : {}),
      },
    });
    if (pendingAutoResponse && !active) {
      pendingAutoResponse = false;
      startResponse({});
    }
  }

  function speakText(response, text, signal) {
    const itemId = nextId('item');
    emit({
      type: 'response.output_audio_transcript.delta',
      response_id: response.id,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    });
    emit({
      type: 'response.output_audio_transcript.done',
      response_id: response.id,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      transcript: text,
    });
    return {
      id: itemId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_audio', transcript: text }],
      response_id: response.id,
    };
  }

  async function startResponse(options, eventId) {
    const outOfBand = options.conversation === 'none';
    const response = {
      id: nextId('resp'),
      metadata: options.metadata ?? null,
      controller: new AbortController(),
    };
    if (!outOfBand) active = response;
    emit({
      type: 'response.created',
      response: {
        id: response.id,
        object: 'realtime.response',
        status: 'in_progress',
        output: [],
        metadata: response.metadata,
      },
    });
    const { signal } = response.controller;

    if (outOfBand) {
      // Progress lines are code-authored: read them aloud, no model needed.
      const line = (options.input || [])
        .map((item) => partsText(item?.content))
        .join(' ')
        .trim();
      const output = line ? [speakText(response, line, signal)] : [];
      finish(response, 'completed', output);
      if (line) play(response.id, line, signal);
      return;
    }

    const messages = toChatTurns(items);
    if (!messages.length) {
      finish(response, 'completed');
      return;
    }
    let reply;
    try {
      reply = await respond(
        {
          messages,
          instructions: options.instructions,
          toolChoice: options.tool_choice,
        },
        { signal },
      );
    } catch (error) {
      if (signal.aborted) return; // the cancel already ended this response
      finish(response, 'failed', [], {
        type: 'failed',
        error: {
          type: 'server_error',
          code: 'open_voice_failed',
          message: error?.message || 'Open voice request failed',
        },
      });
      return;
    }
    if (signal.aborted || readyState !== 'open') return;

    const output = [];
    const text = String(reply?.content || '').trim();
    if (text) {
      const item = speakText(response, text, signal);
      items.push(item);
      output.push(item);
    }
    for (const call of reply?.tool_calls || []) {
      const item = {
        id: nextId('fc'),
        type: 'function_call',
        status: 'completed',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
        response_id: response.id,
      };
      items.push(item);
      output.push(item);
      emit({
        type: 'response.output_item.done',
        response_id: response.id,
        output_index: output.length - 1,
        item,
      });
    }
    finish(response, 'completed', output);
    if (text) play(response.id, text, signal);
  }

  function cancel(responseId) {
    if (!active || (responseId && responseId !== active.id)) return;
    const response = active;
    response.controller.abort();
    speech.stop();
    finish(response, 'cancelled');
  }

  function handle(message) {
    switch (message?.type) {
      case 'session.update':
        emit({ type: 'session.updated' });
        return;
      case 'conversation.item.create': {
        const item = {
          ...message.item,
          id: message.item?.id || nextId('item'),
        };
        items.push(item);
        emit({
          type: 'conversation.item.created',
          item: { id: item.id, type: item.type },
        });
        return;
      }
      case 'conversation.item.delete': {
        const index = items.findIndex((item) => item.id === message.item_id);
        if (index < 0) {
          emitError(
            'item_not_found',
            `Item ${message.item_id} not found`,
            message.event_id,
          );
          return;
        }
        items.splice(index, 1);
        emit({ type: 'conversation.item.deleted', item_id: message.item_id });
        return;
      }
      case 'response.create':
        if (active && message.response?.conversation !== 'none') {
          emitError(
            'conversation_already_has_active_response',
            'Conversation already has an active response',
            message.event_id,
          );
          return;
        }
        startResponse(message.response || {}, message.event_id);
        return;
      case 'response.cancel':
        cancel(message.response_id);
        return;
      case 'output_audio_buffer.clear':
        speech.stop();
        emit({
          type: 'output_audio_buffer.cleared',
          response_id: active?.id || null,
        });
        return;
      default:
        return; // input_audio_buffer.* and others have no local meaning
    }
  }

  const channel = {
    label: 'oai-events',
    get readyState() {
      return readyState;
    },
    addEventListener: (...args) => target.addEventListener(...args),
    removeEventListener: (...args) => target.removeEventListener(...args),
    send(data) {
      if (readyState !== 'open')
        throw new Error('Open voice channel is not open');
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      handle(message);
    },
    close() {
      if (readyState === 'closed') return;
      readyState = 'closing';
      active?.controller.abort();
      active = null;
      speech.stop();
      readyState = 'closed';
      target.dispatchEvent(new Event('close'));
    },
  };

  return {
    channel,
    open() {
      if (readyState !== 'connecting') return;
      readyState = 'open';
      target.dispatchEvent(new Event('open'));
      emit({
        type: 'session.created',
        session: { type: 'realtime', model: 'open-voice' },
      });
    },
    userSpeechStarted() {
      userItemId = nextId('item');
      emit({
        type: 'input_audio_buffer.speech_started',
        item_id: userItemId,
        audio_start_ms: 0,
      });
    },
    userSpeechStopped() {
      emit({
        type: 'input_audio_buffer.speech_stopped',
        item_id: userItemId,
        audio_end_ms: 0,
      });
      emit({ type: 'input_audio_buffer.committed', item_id: userItemId });
    },
    userTranscript(text) {
      const transcript = String(text || '').trim();
      const itemId = userItemId || nextId('item');
      userItemId = null;
      if (!transcript) {
        // Nothing intelligible. The client keeps the user turn open until a
        // response starts, so close it with an empty one.
        const response = { id: nextId('resp'), metadata: null };
        emit({
          type: 'response.created',
          response: {
            id: response.id,
            object: 'realtime.response',
            status: 'in_progress',
            output: [],
          },
        });
        finish(response, 'completed');
        return;
      }
      items.push({
        id: itemId,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', transcript }],
      });
      emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: itemId,
        content_index: 0,
        transcript,
      });
      // Realtime's turn detection creates the response itself (create_response).
      if (active) pendingAutoResponse = true;
      else startResponse({});
    },
  };
}
