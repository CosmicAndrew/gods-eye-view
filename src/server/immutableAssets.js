/**
 * Cache content-hashed build assets immutably.
 *
 * `vite preview` - which serves the deployment, because the API surface is
 * plugin middleware - sends `cache-control: no-cache` for everything. On a
 * hashed filename that is pure waste: the browser revalidates several MB of
 * JS and JSON it already holds on every visit. A hashed name cannot change
 * contents without changing the URL, so it is safe to freeze for a year.
 *
 * index.html is deliberately excluded: it is what points at the current
 * hashes, so freezing it would pin visitors to a stale build.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** Vite emits `name-<hash>.ext`; the hash is base64url-ish and 8+ chars. */
const HASHED_ASSET = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i;

export function immutableAssets() {
  function install(middlewares) {
    middlewares.use((req, res, next) => {
      const pathname = (req.url || '').split('?')[0];
      if (HASHED_ASSET.test(pathname)) {
        res.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
        // The static handler sets its own Cache-Control after this returns, so
        // pin ours: without this the header is silently downgraded again.
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (name, value) =>
          String(name).toLowerCase() === 'cache-control'
            ? res
            : setHeader(name, value);
      }
      next();
    });
  }

  return {
    name: 'immutable-assets',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
