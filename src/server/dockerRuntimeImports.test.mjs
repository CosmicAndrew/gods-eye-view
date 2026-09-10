/**
 * Everything vite.config.js imports must ship in the runtime image.
 *
 * The container runs `vite preview`, which evaluates vite.config.js at boot, so
 * a relative import whose file was never COPYed into the runtime stage is not a
 * missing feature — it is ERR_MODULE_NOT_FOUND at PID 1, i.e. a container that
 * never serves a request. The runtime stage deliberately copies a short list
 * (node_modules, dist, package.json, vite.config.js, index.html, src, config,
 * public) rather than the whole tree, so adding an import from a new top-level
 * directory silently breaks the deploy while every local test still passes.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** Top-level path segment of each relative import in the config. */
function configImportRoots() {
  const source = read('vite.config.js');
  const roots = new Set();
  for (const match of source.matchAll(/\bfrom\s+'\.\/([^']+)'/g)) {
    roots.add(match[1].split('/')[0]);
  }
  return [...roots].sort();
}

/** Paths the runtime stage copies out of the build stage. */
function runtimeCopiedRoots() {
  const dockerfile = read('Dockerfile');
  const runtimeStage = dockerfile.slice(dockerfile.indexOf('AS runtime'));
  const roots = new Set();
  for (const match of runtimeStage.matchAll(/^COPY --from=build \/app\/(\S+)/gm)) {
    roots.add(match[1].split('/')[0]);
  }
  return roots;
}

test('every path vite.config.js imports is copied into the runtime image', () => {
  const copied = runtimeCopiedRoots();
  const missing = configImportRoots().filter((root) => !copied.has(root));

  assert.deepEqual(
    missing,
    [],
    `vite.config.js imports from these directories, but the Dockerfile runtime stage `
    + `never copies them — the container would fail at startup with `
    + `ERR_MODULE_NOT_FOUND: ${JSON.stringify(missing)}`,
  );
});

test('the runtime stage still copies the config itself', () => {
  // A guard on the guard: if this drops out, the test above passes vacuously.
  assert.ok(runtimeCopiedRoots().has('vite.config.js'));
  assert.ok(configImportRoots().length > 0, 'no relative imports parsed — regex drifted');
});
