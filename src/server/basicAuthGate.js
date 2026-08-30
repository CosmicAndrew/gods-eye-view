import { createHash, timingSafeEqual } from 'node:crypto';

/** Hosts that only this machine can reach. Anything else is a public bind. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Does a server bound to `host` have to be behind the gate?
 *
 * Derived from the host actually bound, not from an env var: `vite preview
 * --host 0.0.0.0` binds publicly while leaving HOST unset, so reading the
 * environment alone left the CLI path serving everything unauthenticated.
 * Vite's `--host` with no value resolves to `true`, which is also public.
 */
export function requiresGate(host) {
  if (host === true) return true;
  if (!host || typeof host !== 'string') return false;
  return !LOOPBACK.has(host.trim());
}

/**
 * HTTP Basic gate for the whole app, dev server and preview alike.
 *
 * Deployed, this app hands out real money: the browser bundle carries the
 * Google Maps key, and /api/realtime/token mints OpenAI sessions against the
 * server's own credentials. Anyone who can load the page can spend both, so a
 * public deployment has to be closed by default.
 *
 * Unset credentials leave the gate uninstalled rather than open-with-a-warning,
 * so localhost keeps working untouched; a half-configured gate (user but no
 * password) also stays shut rather than authenticating against an empty secret.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */

/**
 * Compare without leaking length or position through timing.
 *
 * Digesting first is what makes that true. Comparing the raw bytes forces an
 * early return whenever the lengths differ, which leaks the exact byte length
 * of the username and password to anyone timing responses; SHA-256 makes both
 * sides 32 bytes, so every comparison does identical work.
 */
function safeEqual(a, b) {
  const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * @param {{user?: string, password?: string, realm?: string, required?: boolean}} credentials
 *   `required` marks a deployment that must never serve unprotected. Without it
 *   missing credentials merely uninstall the gate, which is right for localhost
 *   and a silent failure open anywhere public.
 * @returns {import('vite').Plugin}
 */
export function basicAuthGate({ user, password, realm = "God's Eye View", required = false } = {}) {
  const armed = Boolean(user && password);

  // A public bind detected at hook time also requires the gate, so the caller
  // cannot forget to pass `required` on the CLI path.
  function install(middlewares, boundPublicly = false) {
    if (!armed) {
      if (!required && !boundPublicly) return;
      // Refuse to serve rather than serve unguarded: this process hands out the
      // Google Maps key in its bundle and mints OpenAI sessions on request, so
      // one misnamed variable would otherwise publish both. 503, not 401 -
      // nothing the caller can send would help. The message deliberately names
      // no variable, since it is returned to the public internet.
      middlewares.use((req, res) => {
        res.statusCode = 503;
        res.setHeader('Cache-Control', 'no-store');
        res.end('Service unavailable: access control is not configured.');
      });
      return;
    }
    middlewares.use((req, res, next) => {
      const header = req.headers?.authorization || '';
      const [scheme, encoded] = header.split(' ');

      // RFC 7235 makes the auth-scheme case-insensitive; matching only "Basic"
      // locks out a conforming client rather than stopping an attacker.
      if (scheme?.toLowerCase() === 'basic' && encoded) {
        // Buffer.from never throws on bad base64 - it drops invalid bytes - so
        // the separator check below is what actually rejects malformed input.
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator !== -1) {
          const okUser = safeEqual(decoded.slice(0, separator), user);
          const okPassword = safeEqual(decoded.slice(separator + 1), password);
          // Both are evaluated before branching so a wrong username costs the
          // same as a wrong password.
          if (okUser && okPassword) {
            next();
            return;
          }
        }
      }

      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
      res.end('Authentication required');
    });
  }

  return {
    name: 'basic-auth-gate',
    configureServer(server) {
      install(server.middlewares, requiresGate(server?.config?.server?.host));
    },
    configurePreviewServer(server) {
      install(server.middlewares, requiresGate(server?.config?.preview?.host));
    },
  };
}
