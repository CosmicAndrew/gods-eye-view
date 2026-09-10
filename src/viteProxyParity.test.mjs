/**
 * Every /api proxy must serve the production preview server, not just dev.
 *
 * The app's whole backend is Vite middleware. A plugin that only implements
 * `configureServer` disappears from `vite preview`, so a production build
 * silently loses that data source — the layer renders empty with no error.
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import configFactory from '../vite.config.js';

/** Route paths a plugin registers when Vite installs it on one server hook. */
function registeredRoutes(plugin, hook) {
  const routes = [];
  const server = { middlewares: { use(route) { if (typeof route === 'string') routes.push(route); } } };
  plugin[hook]?.(server);
  return routes.sort();
}

const config = configFactory({ mode: 'development', command: 'serve' });
const { plugins } = config;
const proxyPlugins = plugins.filter((p) => typeof p?.name === 'string' && /-prox(y|ies)$/.test(p.name));

test('every API proxy registers the same routes on preview as on dev', () => {
  assert.ok(proxyPlugins.length > 0, 'no -proxy plugins found in the Vite config');

  const devOnly = proxyPlugins
    .map((plugin) => ({
      name: plugin.name,
      dev: registeredRoutes(plugin, 'configureServer'),
      preview: registeredRoutes(plugin, 'configurePreviewServer'),
    }))
    .filter(({ dev, preview }) => dev.join('|') !== preview.join('|'));

  assert.deepEqual(
    devOnly.map((entry) => entry.name),
    [],
    `these proxies vanish from the production preview server: ${JSON.stringify(devOnly, null, 2)}`,
  );
});

test('the auth gate is still the first plugin', () => {
  // Everything behind it - assets carrying the baked Maps key, the proxies, the
  // OpenAI token minter - is reachable unauthenticated if it ever slips.
  assert.equal(plugins[0]?.name, 'basic-auth-gate');
});

test('the key-setup endpoint never reaches the preview server', () => {
  // Upstream's setup endpoint writes the repo .env and reports which
  // credentials exist. It is dev-only by its own `apply`, but alsoServePreview
  // promotes any configureServer hook onto configurePreviewServer, and preview
  // IS the deployed surface here - wrapping it would publish a
  // credential-write endpoint behind nothing but the basic-auth gate.
  const keySetup = plugins.find((plugin) => plugin?.name === 'gev-key-setup');
  assert.ok(keySetup, 'gev-key-setup missing: upstream not merged yet');
  assert.equal(keySetup.configurePreviewServer, undefined, 'wrapped by alsoServePreview');
  assert.equal(keySetup.apply?.({}, { command: 'serve', isPreview: true }), false);
  assert.equal(keySetup.apply?.({}, { command: 'serve', isPreview: false }), true);
});

test('preview sends the same anti-framing headers as dev', () => {
  // Upstream added these to `server`, which only covers `npm run dev`. This
  // deployment runs `vite preview`, so without mirroring them the live site is
  // the one surface left framable.
  assert.equal(config.preview?.headers?.['X-Frame-Options'], 'DENY');
  assert.equal(config.preview.headers['Content-Security-Policy'], "frame-ancestors 'none'");
  assert.deepEqual(config.preview.headers, config.server?.headers);
});
