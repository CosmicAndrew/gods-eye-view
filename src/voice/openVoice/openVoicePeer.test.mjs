import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenVoicePeer, toChatTurns } from './openVoicePeer.js';

/** A peer wired to scripted model replies and an instant fake speaker. */
function harness(replies = []) {
  const events = [];
  const requests = [];
  const spoken = [];
  let stopped = 0;
  const queue = [...replies];
  const peer = createOpenVoicePeer({
    respond: async (turn, { signal }) => {
      requests.push(turn);
      const next = queue.shift();
      if (typeof next === 'function') return next(signal);
      if (next instanceof Error) throw next;
      return next ?? { content: 'ok', tool_calls: [] };
    },
    speech: {
      speak: async (text) => { spoken.push(text); },
      stop: () => { stopped += 1; },
    },
  });
  peer.channel.addEventListener('message', (event) => events.push(JSON.parse(event.data)));
  const send = (message) => peer.channel.send(JSON.stringify(message));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const types = () => events.map((event) => event.type);
  return { peer, events, requests, spoken, send, settle, types, stopped: () => stopped };
}

test('the channel opens like a data channel', async () => {
  const h = harness();
  let opened = false;
  h.peer.channel.addEventListener('open', () => { opened = true; });
  assert.equal(h.peer.channel.readyState, 'connecting');
  h.peer.open();
  assert.equal(h.peer.channel.readyState, 'open');
  assert.equal(opened, true);
  h.peer.channel.close();
  assert.equal(h.peer.channel.readyState, 'closed');
});

test('a spoken turn produces the Realtime event sequence the client consumes', async () => {
  const h = harness([{ content: 'Flying to Paris.', tool_calls: [] }]);
  h.peer.open();
  h.peer.userSpeechStarted();
  h.peer.userSpeechStopped();
  h.peer.userTranscript('fly to paris');
  await h.settle();
  await h.settle();

  assert.deepEqual(h.types(), [
    'session.created',
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.committed',
    'conversation.item.input_audio_transcription.completed',
    'response.created',
    'response.output_audio_transcript.delta',
    'response.output_audio_transcript.done',
    'response.done',
    'output_audio_buffer.started',
    'output_audio_buffer.stopped',
  ]);
  const created = h.events.find((e) => e.type === 'response.created');
  const done = h.events.find((e) => e.type === 'response.done');
  assert.equal(done.response.id, created.response.id);
  assert.equal(done.response.status, 'completed');
  assert.equal(h.events.find((e) => e.type === 'output_audio_buffer.started').response_id, created.response.id);
  assert.equal(h.events.find((e) => e.type.endsWith('transcription.completed')).transcript, 'fly to paris');
  assert.deepEqual(h.requests[0].messages, [{ role: 'user', content: 'fly to paris' }]);
  assert.deepEqual(h.spoken, ['Flying to Paris.']);
});

test('tool calls surface as function_call output items, and their outputs go back in order', async () => {
  const h = harness([
    { content: '', tool_calls: [{ id: 'call_1', name: 'fly_to_location', arguments: '{"query":"Paris"}' }] },
    { content: 'Done.', tool_calls: [] },
  ]);
  h.peer.open();
  h.peer.userTranscript('fly to paris');
  await h.settle();
  const item = h.events.find((e) => e.type === 'response.output_item.done').item;
  assert.deepEqual(
    { type: item.type, call_id: item.call_id, name: item.name, arguments: item.arguments },
    { type: 'function_call', call_id: 'call_1', name: 'fly_to_location', arguments: '{"query":"Paris"}' },
  );

  // A viewport context item can land between the call and its output.
  h.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: '{"view":"Paris"}' }] } });
  h.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' } });
  h.send({ type: 'response.create', response: { instructions: 'Confirm once.' } });
  await h.settle();

  const second = h.requests[1];
  assert.equal(second.instructions, 'Confirm once.');
  assert.deepEqual(second.messages, [
    { role: 'user', content: 'fly to paris' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'fly_to_location', arguments: '{"query":"Paris"}' }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    { role: 'user', content: 'App context (not spoken by the operator): {"view":"Paris"}' },
  ]);
  assert.deepEqual(h.spoken, ['Done.']);
});

test('an overlapping response.create is refused the way Realtime refuses it', async () => {
  let release;
  const h = harness([() => new Promise((resolve) => { release = resolve; })]);
  h.peer.open();
  h.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } });
  h.send({ type: 'response.create' });
  h.send({ type: 'response.create', event_id: 'evt_2' });
  const error = h.events.find((e) => e.type === 'error');
  assert.equal(error.error.code, 'conversation_already_has_active_response');
  assert.equal(error.error.event_id, 'evt_2');
  release({ content: 'hello', tool_calls: [] });
  await h.settle();
  assert.equal(h.events.filter((e) => e.type === 'response.done').length, 1);
});

test('response.cancel aborts the model call and ends the response as cancelled', async () => {
  let aborted = false;
  const h = harness([(signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); });
  })]);
  h.peer.open();
  h.peer.userTranscript('long question');
  await h.settle();
  h.send({ type: 'response.cancel' });
  await h.settle();
  assert.equal(aborted, true);
  assert.equal(h.events.find((e) => e.type === 'response.done').response.status, 'cancelled');
  assert.deepEqual(h.spoken, []);
});

test('output_audio_buffer.clear stops playback and reports cleared', () => {
  const h = harness();
  h.peer.open();
  h.send({ type: 'output_audio_buffer.clear' });
  assert.equal(h.stopped(), 1);
  assert.equal(h.types().at(-1), 'output_audio_buffer.cleared');
});

test('a progress line is spoken verbatim without a model call', async () => {
  const h = harness();
  h.peer.open();
  h.send({
    type: 'response.create',
    event_id: 'gev_progress_1',
    response: {
      conversation: 'none',
      metadata: { gev: 'progress' },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Still searching.' }] }],
    },
  });
  await h.settle();
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.spoken, ['Still searching.']);
  assert.equal(h.events.find((e) => e.type === 'response.created').response.metadata.gev, 'progress');
});

test('a blank transcript still closes the user turn', async () => {
  const h = harness();
  h.peer.open();
  h.peer.userSpeechStarted();
  h.peer.userTranscript('   ');
  await h.settle();
  // The client holds userTurnPending until a response.created arrives.
  assert.deepEqual(h.types().slice(-2), ['response.created', 'response.done']);
  assert.equal(h.requests.length, 0);
});

test('a failed model call ends the response as failed, not silently', async () => {
  const h = harness([new Error('Open voice request failed')]);
  h.peer.open();
  h.peer.userTranscript('hi');
  await h.settle();
  const done = h.events.find((e) => e.type === 'response.done');
  assert.equal(done.response.status, 'failed');
  assert.ok(done.response.status_details.error.message);
});

test('deleting an unknown item answers item_not_found with the echoed event id', () => {
  const h = harness();
  h.peer.open();
  h.send({ type: 'conversation.item.delete', item_id: 'msg_missing', event_id: 'evt_del' });
  const error = h.events.at(-1);
  assert.equal(error.error.code, 'item_not_found');
  assert.equal(error.error.event_id, 'evt_del');
});

test('chat turns never start with a tool result and unanswered calls get a placeholder', () => {
  const items = [
    { type: 'function_call', call_id: 'c0', name: 'a', arguments: '{}', response_id: 'r0' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    { type: 'function_call', call_id: 'c1', name: 'b', arguments: '{}', response_id: 'r1' },
  ];
  const turns = toChatTurns(items, { maxMessages: 10 });
  assert.equal(turns[0].role, 'user');
  assert.deepEqual(turns.at(-1), { role: 'tool', tool_call_id: 'c1', content: '{"ok":false,"error":"No result was returned for this call."}' });
});

test('images are left out of text turns', () => {
  const turns = toChatTurns([
    { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' }, { type: 'input_text', text: 'what is this' }] },
  ]);
  assert.deepEqual(turns, [{ role: 'user', content: 'what is this' }]);
});
