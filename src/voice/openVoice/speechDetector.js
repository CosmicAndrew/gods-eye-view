/**
 * Open-source voice: when the operator starts and stops talking.
 *
 * An energy detector over 32 ms frames with an adaptive noise floor. The
 * microphone already runs the browser's echo cancellation and noise
 * suppression, and Whisper discards what turns out to be non-speech, so this
 * only has to find the edges of an utterance: an onset window so a click is
 * not a turn, pre-roll so the first syllable survives, and a hangover so a
 * pause between words does not end it.
 */

export const FRAME_SAMPLES = 512;

const rms = (frame) => {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
};

/**
 * @param {{ sampleRate?: number, onsetMs?: number, hangoverMs?: number, preRollMs?: number, maxUtteranceMs?: number }} [options]
 */
export function createSpeechDetector({
  sampleRate = 16000,
  onsetMs = 96,
  hangoverMs = 800,
  preRollMs = 320,
  maxUtteranceMs = 20_000,
} = {}) {
  const frameMs = (FRAME_SAMPLES / sampleRate) * 1000;
  const onsetFrames = Math.max(1, Math.round(onsetMs / frameMs));
  const hangoverFrames = Math.max(1, Math.round(hangoverMs / frameMs));
  const preRollFrames = Math.max(0, Math.round(preRollMs / frameMs));
  const maxFrames = Math.max(1, Math.round(maxUtteranceMs / frameMs));

  let floor = 0.003;
  let loudRun = 0;
  let quietRun = 0;
  let speaking = false;
  let preRoll = [];
  let utterance = [];

  const threshold = () => Math.max(0.012, floor * 3.5);

  function end() {
    const total = utterance.reduce((n, f) => n + f.length, 0);
    const audio = new Float32Array(total);
    let offset = 0;
    for (const f of utterance) {
      audio.set(f, offset);
      offset += f.length;
    }
    speaking = false;
    utterance = [];
    preRoll = [];
    loudRun = 0;
    quietRun = 0;
    return { type: 'end', audio };
  }

  return {
    /** Feed one frame; returns a start/end event or null. */
    feed(input) {
      const frame = Float32Array.from(input);
      const level = rms(frame);
      const loud = level > threshold();
      // The floor follows quiet frames quickly and loud ones slowly, so a
      // steady fan or engine becomes the floor instead of an endless turn.
      floor = loud
        ? floor + (level - floor) * 0.004
        : floor + (level - floor) * 0.05;
      floor = Math.min(Math.max(floor, 0.0005), 0.2);

      if (!speaking) {
        preRoll.push(frame);
        if (preRoll.length > preRollFrames + onsetFrames) preRoll.shift();
        loudRun = loud ? loudRun + 1 : 0;
        if (loudRun >= onsetFrames) {
          speaking = true;
          utterance = preRoll;
          preRoll = [];
          quietRun = 0;
          return { type: 'start' };
        }
        return null;
      }

      utterance.push(frame);
      quietRun = loud ? 0 : quietRun + 1;
      if (quietRun >= hangoverFrames || utterance.length >= maxFrames)
        return end();
      return null;
    },
    get speaking() {
      return speaking;
    },
    reset() {
      speaking = false;
      utterance = [];
      preRoll = [];
      loudRun = 0;
      quietRun = 0;
    },
  };
}
