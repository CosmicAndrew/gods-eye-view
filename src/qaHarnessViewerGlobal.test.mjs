/**
 * The frame-rate harness must read the viewer global the app actually exposes.
 *
 * qa-fps-under-load.mjs drives the camera so it can sample frames "under load",
 * and read `window.viewer` to do it — a global this app has never assigned.
 * Optional chaining made that silent: `cam?.rotateRight?.()` is a no-op, so the
 * harness reported a frame rate for a PARKED camera while its own header
 * claimed motion, and qa-boot-smoke.mjs reported `primitives: null` forever.
 * Every number those two produced under load was measuring the wrong thing.
 *
 * The app exposes `window.__godsEyeView` (src/app/tools.js), which every other
 * qa-*.mjs already uses. These anchors keep the harnesses pointed at it, and
 * keep a missing camera loud instead of silent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** Slice between a start marker and the first following end marker. */
function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return source.slice(start, end + endMarker.length);
}

test('the app exposes the viewer on __godsEyeView', () => {
  // If this global is ever renamed, the harnesses below must move with it.
  // Assigned in src/app/tools.js since upstream's application split.
  const exposed = block(read('src/app/tools.js'), 'window.__godsEyeView = {', '};');
  assert.match(exposed, /^\s*viewer,/m);
});

for (const harness of ['scripts/qa-fps-under-load.mjs', 'scripts/qa-boot-smoke.mjs']) {
  test(`${harness} reads the viewer global that exists`, () => {
    const source = read(harness);
    assert.match(source, /window\.__godsEyeView\??\.viewer/,
      'harness must read window.__godsEyeView.viewer');
    assert.doesNotMatch(source, /\bwindow\.viewer\b/,
      'window.viewer is never assigned by this app — reading it silently yields undefined');
  });
}

test('a missing camera fails the frame-rate run instead of parking it', () => {
  // The whole point of this harness is motion. A run that cannot move the
  // camera must not return a number that looks like a measurement.
  const sampler = block(
    read('scripts/qa-fps-under-load.mjs'),
    'const cam =',
    'requestAnimationFrame(tick)',
  );
  assert.match(sampler, /throw new Error/,
    'no throw guarding a missing camera: a parked run would report a bogus fps');
});
