import { createOpenVoicePeer } from './openVoicePeer.js';
import { createSpeechDetector, FRAME_SAMPLES } from './speechDetector.js';
import { cleanTranscript, speechChunks } from './speechText.js';

/**
 * Open voice: the browser side of GEV_VOICE_ENGINE=open.
 *
 * Microphone → speech detector → /api/voice/open/transcribe (Groq Whisper) →
 * OpenVoicePeer, which the voice controller drives exactly like a Realtime
 * data channel; replies come back as text from /api/voice/open/respond and are
 * voiced by /api/voice/open/speak (Fish Audio, then Chatterbox) through a
 * MediaStream, so the existing audio element and voice visualizer work
 * unchanged. If synthesis fails or is too slow, the browser's own voice
 * speaks instead.
 *
 * Barge-in by voice is off while a reply plays: without WebRTC's echo path
 * the microphone hears the speaker, and every reply would interrupt itself.
 * Push-to-talk and typed commands still cut in.
 */

const TARGET_RATE = 16000;
const ECHO_TAIL_MS = 400;

// Downsamples the microphone to 16 kHz mono and posts fixed-size frames.
const TAP_WORKLET = `
class GevMicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${TARGET_RATE};
    this.frame = new Float32Array(${FRAME_SAMPLES});
    this.filled = 0;
    this.position = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    while (this.position < channel.length) {
      const i = Math.floor(this.position);
      const next = i + 1 < channel.length ? channel[i + 1] : channel[i];
      this.frame[this.filled++] = channel[i] + (next - channel[i]) * (this.position - i);
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame.slice());
        this.filled = 0;
      }
      this.position += this.ratio;
    }
    this.position -= channel.length;
    return true;
  }
}
registerProcessor('gev-mic-tap', GevMicTap);
`;

/** 16-bit PCM mono WAV, the format /transcribe accepts. */
function encodeWav(samples, rate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset, value) =>
    [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      44 + i * 2,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  }
  return view.buffer;
}

const SYNTH_DEADLINE_MS = 4000;

/** Resolve with the promise's value, or null once the deadline passes. */
function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const hasBrowserVoice = () =>
  Boolean(globalThis.speechSynthesis) &&
  typeof SpeechSynthesisUtterance !== 'undefined';

/** Speak with the browser's built-in voice; resolves when done or stopped. */
function speakWithBrowser(text, signal) {
  const synth = globalThis.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined')
    return Promise.resolve();
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = utterance.onerror = () => resolve();
    signal.addEventListener(
      'abort',
      () => {
        synth.cancel();
        resolve();
      },
      { once: true },
    );
    synth.speak(utterance);
  });
}

/**
 * @param {{
 *   stream: MediaStream,
 *   signal: AbortSignal,
 *   onStatus?: (detail: string) => void,
 *   debugLog?: (event: string, detail?: object) => void,
 *   respondEndpoint?: string,
 * }} options
 */
export async function startOpenVoiceTransport({
  stream,
  signal,
  onStatus = () => {},
  debugLog = () => {},
  respondEndpoint = '/api/voice/open/respond',
  transcribeEndpoint = '/api/voice/open/transcribe',
  speakEndpoint = '/api/voice/open/speak',
}) {
  const micContext = new AudioContext();
  const outContext = new AudioContext();
  const output = outContext.createMediaStreamDestination();
  const sources = new Set();
  let speechController = null;
  let playingUntil = 0;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    speechController?.abort();
    globalThis.speechSynthesis?.cancel?.();
    micContext.close().catch(() => {});
    outContext.close().catch(() => {});
  };
  if (signal?.aborted) {
    dispose();
    throw signal.reason;
  }
  onStatus('');

  async function transcribe(audio) {
    const response = await fetch(transcribeEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: encodeWav(audio, TARGET_RATE),
      cache: 'no-store',
      redirect: 'error',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        data?.error || `Transcription failed: HTTP ${response.status}`,
      );
    return String(data?.text || '');
  }

  /** Fetch and decode one sentence of reply audio; resolves null on failure. */
  async function synthesize(text, abort) {
    const started = performance.now();
    try {
      const response = await fetch(speakEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: abort,
        cache: 'no-store',
        redirect: 'error',
      });
      if (!response.ok)
        throw new Error(`Speech synthesis failed: HTTP ${response.status}`);
      const provider = response.headers.get('X-GEV-TTS-Provider') || 'hosted';
      const buffer = await outContext.decodeAudioData(
        await response.arrayBuffer(),
      );
      return {
        buffer,
        provider,
        synthMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      if (!abort.aborted)
        debugLog('open_voice.tts.failed', {
          error: error?.message || String(error),
        });
      return null;
    }
  }

  function stopSpeech() {
    speechController?.abort();
    speechController = null;
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    sources.clear();
    globalThis.speechSynthesis?.cancel?.();
  }

  function playBuffer(buffer, abort) {
    return new Promise((resolve) => {
      if (abort.aborted || disposed) return resolve();
      const source = outContext.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      sources.add(source);
      source.onended = () => {
        sources.delete(source);
        resolve();
      };
      abort.addEventListener('abort', () => resolve(), { once: true });
      source.start();
    });
  }

  async function speak(text, { signal: responseSignal }) {
    const controller = new AbortController();
    speechController = controller;
    const abort = AbortSignal.any([controller.signal, responseSignal]);
    const chunks = speechChunks(text);
    outContext.resume().catch(() => {});
    try {
      // Fetch one sentence ahead of the one playing. A provider that fails or
      // misses the deadline hands the rest of the reply to the browser's
      // voice rather than leave the operator waiting.
      let hosted = true;
      let next = chunks.length ? synthesize(chunks[0], abort) : null;
      for (let i = 0; i < chunks.length && !abort.aborted; i += 1) {
        playingUntil = Infinity;
        const current = next;
        next =
          hosted && i + 1 < chunks.length
            ? synthesize(chunks[i + 1], abort)
            : null;
        let clip = current
          ? await withDeadline(current, SYNTH_DEADLINE_MS)
          : null;
        if (current && !clip && !hasBrowserVoice()) clip = await current; // no fallback voice: wait it out
        if (current && !clip) {
          hosted = false;
          next = null;
          current.then(
            (late) =>
              late &&
              debugLog('open_voice.tts.late', { synthMs: late.synthMs }),
          );
        }
        if (abort.aborted) break;
        const voice = clip ? clip.provider : 'browser';
        debugLog('open_voice.spoke', {
          voice,
          chars: chunks[i].length,
          synthMs: clip?.synthMs ?? null,
        });
        if (clip) await playBuffer(clip.buffer, abort);
        else await speakWithBrowser(chunks[i], abort);
      }
    } finally {
      if (speechController === controller) speechController = null;
      playingUntil = performance.now() + ECHO_TAIL_MS;
    }
  }

  async function respond(turn, { signal: responseSignal }) {
    const response = await fetch(respondEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(turn),
      signal: responseSignal,
      cache: 'no-store',
      redirect: 'error',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.message)
      throw new Error(
        data?.error || `Open voice request failed: HTTP ${response.status}`,
      );
    debugLog('open_voice.respond', {
      provider: data.provider || null,
      toolCalls: data.message.tool_calls?.length || 0,
    });
    return data.message;
  }

  const peer = createOpenVoicePeer({
    respond,
    speech: { speak, stop: stopSpeech },
  });

  // Microphone → detector → Whisper → peer.
  const detector = createSpeechDetector({ sampleRate: TARGET_RATE });
  let transcribing = Promise.resolve();
  const tapUrl = URL.createObjectURL(
    new Blob([TAP_WORKLET], { type: 'text/javascript' }),
  );
  try {
    await micContext.audioWorklet.addModule(tapUrl);
  } finally {
    URL.revokeObjectURL(tapUrl);
  }
  const tap = new AudioWorkletNode(micContext, 'gev-mic-tap');
  const mute = micContext.createGain();
  mute.gain.value = 0;
  micContext.createMediaStreamSource(stream).connect(tap);
  tap.connect(mute).connect(micContext.destination);
  micContext.resume().catch(() => {});
  tap.port.onmessage = (event) => {
    if (disposed || peer.channel.readyState !== 'open') return;
    if (performance.now() < playingUntil) {
      // The speaker is talking: what the mic hears now is mostly the reply.
      if (detector.speaking) detector.reset();
      return;
    }
    const detected = detector.feed(event.data);
    if (detected?.type === 'start') peer.userSpeechStarted();
    if (detected?.type === 'end') {
      peer.userSpeechStopped();
      const audio = detected.audio;
      const seconds = audio.length / TARGET_RATE;
      transcribing = transcribing.then(async () => {
        let text = '';
        try {
          text = cleanTranscript(await transcribe(audio), { seconds });
        } catch (error) {
          debugLog('open_voice.stt.failed', {
            error: error?.message || String(error),
          });
        }
        if (!disposed) peer.userTranscript(text);
      });
    }
  };

  const channelClose = peer.channel.close;
  peer.channel.close = () => {
    channelClose();
    dispose();
  };

  return {
    channel: peer.channel,
    open: () => peer.open(),
    remoteStream: output.stream,
    peerConnection: {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      iceGatheringState: 'complete',
      signalingState: 'stable',
      close: dispose,
    },
    dispose,
  };
}
