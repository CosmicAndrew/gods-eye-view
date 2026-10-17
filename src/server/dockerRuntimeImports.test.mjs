/**
 * Everything vite.config.js imports must ship in the runtime image.
 *
 * The container runs `vite preview`, which evaluates vite.config.js at boot, so
 * a relative import whose file was never COPYed into the runtime stage is not a
 * missing feature — it is ERR_MODULE_NOT_FOUND at PID 1, i.e. a container that
 * never serves a request. The runtime stage deliberately copies a short list
 * rather than the whole tree, so adding an import from a new top-level
 * directory silently breaks the deploy while every local test still passes.
 *
 * The walk is transitive. Since upstream split the config, vite.config.js is a
 * three-line re-export of server/standalone/vite.config.js; checking only its
 * direct imports would pass while build/ or a scripts/ module went missing.
 *
 * Lives in src/ because the unit runner discovers src/**\/*.test.mjs only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');
const DOCKERFILE = 'Dockerfile.cloudrun';

/** Repo-relative POSIX path of every module the config reaches by relative import. */
function configImportGraph() {
  const seen = new Set();
  const visit = (absolute) => {
    const rel = path.relative(repoRoot, absolute).split(path.sep).join('/');
    if (seen.has(rel)) return;
    seen.add(rel);
    const source = readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)'(\.{1,2}\/[^']+)'/g)) {
      const target = path.resolve(path.dirname(absolute), match[1]);
      // Template-built or comment-embedded specifiers do not resolve; only
      // real files can be missing from the image.
      if (existsSync(target) && /\.m?js$/.test(target)) visit(target);
    }
  };
  visit(path.join(repoRoot, 'vite.config.js'));
  return [...seen].sort();
}

/** Paths the runtime stage copies out of the build stage. */
function runtimeCopiedPaths() {
  const dockerfile = read(DOCKERFILE);
  const runtimeStage = dockerfile.slice(dockerfile.indexOf('AS runtime'));
  return [...runtimeStage.matchAll(/^COPY --from=build \/app\/(\S+)/gm)].map((match) => match[1]);
}

const isCopied = (file, copied) =>
  copied.some((entry) => file === entry || file.startsWith(`${entry}/`));

test('every module vite.config.js reaches is copied into the runtime image', () => {
  const copied = runtimeCopiedPaths();
  const missing = configImportGraph().filter((file) => !isCopied(file, copied));

  assert.deepEqual(
    missing,
    [],
    `vite.config.js reaches these modules, but the ${DOCKERFILE} runtime stage `
    + `never copies them — the container would fail at startup with `
    + `ERR_MODULE_NOT_FOUND: ${JSON.stringify(missing)}`,
  );
});

test('the guard is walking a real graph', () => {
  // A guard on the guard: if either parse drifts, the test above passes vacuously.
  const graph = configImportGraph();
  assert.ok(runtimeCopiedPaths().includes('vite.config.js'));
  assert.ok(graph.includes('server/standalone/vite.config.js'), 'the re-export was not followed');
  assert.ok(graph.length > 50, `only ${graph.length} modules parsed — regex drifted`);
});

test('Cloud Build builds the Cloud Run Dockerfile, not the compose one', () => {
  // The plain Dockerfile is upstream's dev container: `npm run dev` against a
  // bind mount, no build, no gate-ready preview. Built by mistake it deploys a
  // container with no source in it.
  assert.match(read('cloudbuild.yaml'), new RegExp(`- -f\\s+- ${DOCKERFILE.replace('.', '\\.')}\\b`));
});
