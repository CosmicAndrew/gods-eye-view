import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { disposeAisStream } from '../providers/vessels/ais-live.js';
import { basicAuthGate } from '../../src/server/basicAuthGate.js';
import { immutableAssets } from '../../src/server/immutableAssets.js';
import { installProcessGuards } from '../../src/server/processGuards.js';
import { unwatchedRuntimeDirsPlugin } from './unwatched-cache.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  // One process serves every proxy route, and Node ends the process on an
  // unhandled rejection - so without this a single bad upstream response is
  // indistinguishable from an outage. Also drains on SIGTERM, which Cloud Run
  // sends before every scale-down and deploy.
  installProcessGuards({ onShutdown: () => disposeAisStream() });
  const config = createBrowserViteConfig({
    plugins: [
      ...localProviderPlugins({ realtime: { tools: standaloneVoiceTools() } }),
      localMcpPlugin(),
      apiNotFoundPlugin(),
      unwatchedRuntimeDirsPlugin(),
    ],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    command,
  });
  config.plugins.unshift(
    // First, ahead of even the Host check, so nothing - assets, proxies, the
    // OpenAI token minter - is reachable unauthenticated. The Host check is
    // `enforce: 'pre'`, which Vite sorts ahead of every unmarked plugin, so the
    // gate must be marked too; unshifted, it is then first among them.
    // `required` whenever
    // the server is not bound to localhost: missing credentials then refuse
    // service instead of silently uninstalling the gate, because this process
    // serves the Google Maps key inside its bundle and mints OpenAI sessions on
    // request, so failing open publishes both. A localhost run is unaffected
    // and still needs no credentials.
    {
      ...basicAuthGate({
        user: process.env.GEV_AUTH_USER,
        password: process.env.GEV_AUTH_PASSWORD,
        required:
          Boolean(process.env.HOST) &&
          !['localhost', '127.0.0.1', '::1'].includes(process.env.HOST),
      }),
      enforce: 'pre',
    },
    // After the gate, before the static handler whose header it overrides.
    immutableAssets(),
    // Node closes idle keep-alive sockets after 5s; Cloud Run's load balancer
    // holds them far longer and reuses one it believes is open, which surfaces
    // as intermittent 502s under no particular load. The server must outlive
    // the balancer's idle window, and headersTimeout must exceed keepAlive.
    {
      name: 'keepalive-timeouts',
      configurePreviewServer({ httpServer }) {
        if (!httpServer) return;
        httpServer.keepAliveTimeout = 620_000;
        httpServer.headersTimeout = 630_000;
      },
    },
  );
  // `vite preview` is what serves a deployment here, because the whole API
  // surface is plugin middleware. Vite defaults preview.host to server.host but
  // NOT preview.port, which stays 4173 - so the platform's PORT (8080 on Cloud
  // Run) would bind nothing and every request would fail the health probe.
  config.preview = {
    ...config.preview,
    host: config.server.host,
    port: config.server.port,
  };
  return config;
});
