/**
 * Rate-limit failed authentication attempts against the gate.
 *
 * Without this the gate answers every wrong password with an immediate 401 and
 * keeps no count, so guessing is unlimited - confirmed externally at 1,000
 * consecutive attempts, none throttled. The app's own spend limiters cannot
 * cover this: the gate runs ahead of them, so a guess never reaches one.
 *
 * The password is long enough that guessing it is not the realistic risk. The
 * cost is: on Cloud Run every attempt is a billable request, so an unthrottled
 * gate makes the only control on the app an unmetered one.
 *
 * The counter must not become the next problem. An attacker rotating source
 * addresses would grow the map without bound, so tracking is capped and evicts
 * least-recently-seen - which is why a Map is used directly: its insertion
 * order gives LRU eviction with no extra structure.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */

/**
 * @param {{maxFailures?: number, windowMs?: number, cooldownMs?: number,
 *          maxTracked?: number, now?: () => number}} options
 */
export function createAuthThrottle({
  maxFailures = 8,
  windowMs = 5 * 60_000,
  cooldownMs = 5 * 60_000,
  maxTracked = 5_000,
  now = Date.now,
} = {}) {
  /** @type {Map<string, {count: number, first: number, blockedUntil: number}>} */
  const clients = new Map();

  /** Re-insert so the Map's insertion order stays least-recently-seen first. */
  function touch(key, entry) {
    clients.delete(key);
    clients.set(key, entry);
    while (clients.size > maxTracked) {
      clients.delete(clients.keys().next().value);
    }
  }

  return {
    /** Seconds the caller must wait, or 0 if it may proceed. */
    blockedFor(key) {
      const entry = clients.get(key);
      if (!entry) return 0;
      const t = now();
      if (entry.blockedUntil > t) return Math.ceil((entry.blockedUntil - t) / 1000);
      // The cooldown has run out, or the window lapsed with room to spare.
      if (entry.blockedUntil) clients.delete(key);
      return 0;
    },

    recordFailure(key) {
      const t = now();
      const entry = clients.get(key);
      // A first failure, or one arriving after the window closed, starts fresh
      // rather than inheriting a stale count.
      if (!entry || t - entry.first > windowMs) {
        touch(key, { count: 1, first: t, blockedUntil: 0 });
        return;
      }
      entry.count += 1;
      if (entry.count >= maxFailures) entry.blockedUntil = t + cooldownMs;
      touch(key, entry);
    },

    /** Proving you know the password clears your record. */
    recordSuccess(key) {
      clients.delete(key);
    },

    size() {
      return clients.size;
    },
  };
}
