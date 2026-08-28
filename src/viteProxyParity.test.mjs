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

const { plugins } = configFactory({ mode: 'development', command: 'serve' });
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
