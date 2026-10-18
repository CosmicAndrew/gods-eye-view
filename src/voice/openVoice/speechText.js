/**
 * Open-source voice: text at the two ends of the speech pipeline.
 */

// Whisper's well-known outputs for silence or noise on short clips.
const SHORT_CLIP_HALLUCINATIONS = new Set([
  'thank you', 'thanks', 'thank you for watching', 'thanks for watching', 'bye', 'you', 'okay', 'so',
]);

/**
 * Strip Whisper's non-speech markers ([BLANK_AUDIO], (music), [inaudible])
 * and drop the stock sign-offs it hallucinates on a short noisy clip.
 * @param {string} text
 * @param {{ seconds?: number }} [options] Clip length, when known.
 */
export function cleanTranscript(text, { seconds = Infinity } = {}) {
  const cleaned = String(text || '')
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return '';
  const bare = cleaned.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  if (seconds < 1.2 && SHORT_CLIP_HALLUCINATIONS.has(bare)) return '';
  return cleaned;
}

const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|St|Mt|Ft|vs|etc|approx|No)\.$/i;
const MAX_CHUNK = 220;

/**
 * Split a reply into sentence-sized chunks, so the first one can play while
 * the next is synthesized. Abbreviations and decimals do not end a sentence;
 * a run-on longer than the cap is split at word boundaries.
 * @param {string} text
 * @returns {string[]}
 */
export function speechChunks(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > MAX_CHUNK && current) {
      chunks.push(current);
      current = word;
    } else {
      current = next;
    }
    if (/[.!?]["')\]]*$/.test(word) && !ABBREVIATIONS.test(word)) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
