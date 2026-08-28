import { timingSafeEqual } from 'node:crypto';

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

/** Compare without leaking length or position through timing. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * @param {{user?: string, password?: string, realm?: string}} credentials
 * @returns {import('vite').Plugin}
 */
export function basicAuthGate({ user, password, realm = "God's Eye View" } = {}) {
  const armed = Boolean(user && password);

  function install(middlewares) {
    if (!armed) return;
    middlewares.use((req, res, next) => {
      const header = req.headers?.authorization || '';
      const [scheme, encoded] = header.split(' ');

      if (scheme === 'Basic' && encoded) {
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
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
