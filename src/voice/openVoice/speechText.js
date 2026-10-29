/**
 * Open-source voice: text at the two ends of the speech pipeline.
 */

// Whisper's well-known outputs for silence or noise on short clips.
const SHORT_CLIP_HALLUCINATIONS = new Set([
  'thank you',
  'thanks',
  'thank you for watching',
  'thanks for watching',
  'bye',
  'you',
  'okay',
  'so',
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
  const bare = cleaned
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
  if (seconds < 1.2 && SHORT_CLIP_HALLUCINATIONS.has(bare)) return '';
  return cleaned;
}

const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|St|Mt|Ft|vs|etc|approx|No)\.$/i;
const MAX_CHUNK = 220;

/**
 * Fish (the default voice) takes about 0.8 s plus 23 ms per character to
 * synthesize a clip and speaks about 67 ms per character. A clip must arrive
 * within the transport's 4 s deadline of the previous one ending, and is
 * fetched while that one plays, so the opening chunk is capped here and each
 * later one at this plus three times the chunk before it.
 */
const OPENING_CHUNK = 80;

/**
 * Where to cut `chunk` to fit `limit`: after its last clause break that fits,
 * else after its last word that fits; 0 when not even one word fits.
 */
function cutIndex(chunk, limit) {
  let word = 0;
  let clause = 0;
  for (const match of chunk.matchAll(/\S+/g)) {
    const end = match.index + match[0].length;
    if (end > limit) break;
    word = end;
    if (/[,;:–—]$/.test(match[0])) clause = end;
  }
  return clause || word;
}

/** Cut chunks that would not be synthesized in time (see OPENING_CHUNK). */
function paceChunks(chunks) {
  const paced = [];
  let limit = OPENING_CHUNK;
  for (let chunk of chunks) {
    while (chunk.length > limit) {
      const cut = cutIndex(chunk, limit);
      if (!cut) break;
      paced.push(chunk.slice(0, cut));
      limit = OPENING_CHUNK + 3 * cut;
      chunk = chunk.slice(cut).trimStart();
    }
    paced.push(chunk);
    limit = OPENING_CHUNK + 3 * chunk.length;
  }
  return paced;
}

/**
 * Split a reply into sentence-sized chunks, so the first one can play while
 * the next is synthesized. Abbreviations and decimals do not end a sentence;
 * a run-on longer than the cap is split at word boundaries, and a chunk too
 * long to be ready in time is cut at a clause.
 * @param {string} text
 * @returns {string[]}
 */
export function speechChunks(text) {
  const words = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
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
  return paceChunks(chunks);
}
