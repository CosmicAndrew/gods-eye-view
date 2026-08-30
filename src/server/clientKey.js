/**
 * Identify the caller for rate limiting, correctly behind a known proxy.
 *
 * Upstream reads `req.socket.remoteAddress` and deliberately ignores
 * X-Forwarded-For, because a client can rotate that header to mint fresh quota.
 * That is right for a localhost dev proxy, where the socket peer is the client.
 *
 * Deployed behind Cloud Run it is wrong in the other direction: every peer is
 * Google's front end, so all callers collapse into one bucket and a single
 * abuser exhausts the shared OpenAI and Google budget for everyone.
 *
 * The safe reading is from the RIGHT. A proxy appends the address it saw, so
 * with N trusted proxies the entry at `length - N` is the last one an attacker
 * could not write; anything further left is attacker-supplied and ignored. With
 * zero trusted hops the header is not consulted at all, preserving upstream's
 * behaviour exactly - which is why the default is 0 and deployment opts in.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */

/**
 * Fold equivalent spellings of one address together.
 *
 * `1.2.3.4`, `1.2.3.4:443` and `::ffff:1.2.3.4` are the same client, and left
 * distinct they are three separate rate-limit buckets - three times the quota
 * for anyone who varies the spelling. Real IPv6 is left alone: it is only the
 * IPv4-mapped form and a trailing IPv4 port that are rewritten.
 */
function canonicalizeAddress(value) {
  let address = value.trim().toLowerCase();
  if (address.startsWith('::ffff:') && address.includes('.')) address = address.slice('::ffff:'.length);
  // Strip a port only from IPv4 - a bare colon in IPv6 is part of the address.
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(address)) address = address.split(':')[0];
  return address;
}

/** Hops must be a small non-negative integer; anything else means "trust nothing". */
function normalizeHops(value) {
  const hops = Math.trunc(Number(value));
  if (!Number.isFinite(hops) || hops <= 0) return 0;
  return Math.min(hops, 8);
}

/**
 * @param {{headers?: Record<string, string|string[]>, socket?: {remoteAddress?: string}}} req
 * @param {number|string} trustedProxyHops
 * @returns {string}
 */
export function clientKeyFrom(req, trustedProxyHops = 0) {
  const rawSocket = req?.socket?.remoteAddress;
  const socketKey = rawSocket ? canonicalizeAddress(String(rawSocket)) : 'local';
  const hops = normalizeHops(trustedProxyHops);
  if (hops === 0) return socketKey;

  const raw = req?.headers?.['x-forwarded-for'];
  const parts = (Array.isArray(raw) ? raw.join(',') : String(raw ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  // Too few entries means the request did not traverse the proxies we were told
  // to trust, so there is no entry we can attribute to one. Falling back beats
  // reading the left edge, which is exactly the value an attacker controls.
  if (parts.length < hops) return socketKey;

  const selected = parts[parts.length - hops];
  return selected ? canonicalizeAddress(selected) : socketKey;
}
