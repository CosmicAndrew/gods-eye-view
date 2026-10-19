import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechDetector, FRAME_SAMPLES } from './speechDetector.js';
import { cleanTranscript, speechChunks } from './speechText.js';

const RATE = 16000;
const frame = (amplitude) => {
  const samples = new Float32Array(FRAME_SAMPLES);
  for (let i = 0; i < samples.length; i += 1) samples[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return samples;
};
const run = (detector, amplitude, ms) => {
  const events = [];
  const frames = Math.round((ms / 1000) * RATE / FRAME_SAMPLES);
  for (let i = 0; i < frames; i += 1) {
    const event = detector.feed(frame(amplitude));
    if (event) events.push(event);
  }
  return events;
};

test('speech after quiet starts and ends one utterance carrying its audio', () => {
  const detector = createSpeechDetector({ sampleRate: RATE });
  assert.deepEqual(run(detector, 0.002, 1000), [], 'room noise is not speech');
  const start = run(detector, 0.2, 800);
  assert.deepEqual(start.map((e) => e.type), ['start']);
  const end = run(detector, 0.002, 1200);
  assert.deepEqual(end.map((e) => e.type), ['end']);
  const seconds = end[0].audio.length / RATE;
  // Pre-roll keeps the first syllable; the trailing silence is bounded.
  assert.ok(seconds > 0.8 && seconds < 2.2, `utterance length ${seconds}s`);
});

test('a click shorter than the onset window is ignored', () => {
  const detector = createSpeechDetector({ sampleRate: RATE });
  run(detector, 0.002, 500);
  assert.deepEqual(run(detector, 0.3, 40), []);
  assert.deepEqual(run(detector, 0.002, 1000), []);
});

test('a steady loud background raises the floor instead of counting as speech forever', () => {
  const detector = createSpeechDetector({ sampleRate: RATE });
  const events = run(detector, 0.05, 6000);
  // It may trip once while the floor adapts, but it must end.
  assert.ok(events.length <= 2);
  if (events.length) assert.equal(events.at(-1).type, 'end');
});

test('an utterance is cut at the length cap', () => {
  const detector = createSpeechDetector({ sampleRate: RATE, maxUtteranceMs: 3000 });
  run(detector, 0.002, 500);
  const events = run(detector, 0.2, 5000);
  assert.deepEqual(events.map((e) => e.type).slice(0, 2), ['start', 'end']);
});

test('reset drops a half-heard utterance', () => {
  const detector = createSpeechDetector({ sampleRate: RATE });
  run(detector, 0.002, 500);
  run(detector, 0.2, 500);
  detector.reset();
  assert.deepEqual(run(detector, 0.002, 1500), []);
});

test('Whisper non-speech markers and hallucinated sign-offs are dropped', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.equal(cleanTranscript('(music playing)'), '');
  assert.equal(cleanTranscript(' Fly to Paris. '), 'Fly to Paris.');
  assert.equal(cleanTranscript('Thank you.', { seconds: 0.6 }), '');
  assert.equal(cleanTranscript('Thank you.', { seconds: 2.5 }), 'Thank you.');
  assert.equal(cleanTranscript('Show [inaudible] ships near Oslo'), 'Show ships near Oslo');
});

test('replies are spoken in sentence-sized chunks', () => {
  assert.deepEqual(speechChunks('Flying to Paris. Three ships are nearby! Want more?'), [
    'Flying to Paris.',
    'Three ships are nearby!',
    'Want more?',
  ]);
  assert.deepEqual(speechChunks('Dr. Smith is at 3.5 km.'), ['Dr. Smith is at 3.5 km.']);
  const long = `${'word '.repeat(80)}end.`;
  assert.ok(speechChunks(long).every((chunk) => chunk.length <= 220));
  assert.deepEqual(speechChunks('  '), []);
});
