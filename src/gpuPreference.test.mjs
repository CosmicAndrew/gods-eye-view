/**
 * The app must ask for the discrete GPU itself.
 *
 * Without `powerPreference` the browser picks, and on a hybrid-graphics laptop
 * it picks integrated: measured 16.5 fps against 60.1 on the same machine with
 * the same scene. Relying on a Chrome launch flag pushes that choice onto
 * whoever opens the page, and they will mostly open it from a normal window.
 */
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

// Viewer construction moved from main.js to app/viewer.js upstream.
const mainSource = fs.readFileSync(new URL('./app/viewer.js', import.meta.url), 'utf8');

/** Slice app/viewer.js between two literal anchors, so a pin reads one call, not the file. */
function block(start, end) {
  const from = mainSource.indexOf(start);
  assert.ok(from >= 0, `missing source anchor: ${start}`);
  const to = mainSource.indexOf(end, from + start.length);
  assert.ok(to > from, `missing source anchor: ${end}`);
  return mainSource.slice(from, to);
}

test('the Cesium viewer requests the high-performance GPU', () => {
  const contextOptions = block('contextOptions: {', '},');
  assert.match(
    contextOptions,
    /powerPreference:\s*'high-performance'/,
    'the viewer must not leave the adapter choice to the browser default',
  );
});

test('the request sits on the webgl context options, where Cesium forwards it', () => {
  const contextOptions = block('contextOptions: {', '},');
  const webglAt = contextOptions.indexOf('webgl: {');
  const prefAt = contextOptions.indexOf('powerPreference');
  assert.ok(webglAt >= 0, 'expected a webgl block');
  assert.ok(prefAt > webglAt, 'powerPreference must be inside contextOptions.webgl');
});

test('preserveDrawingBuffer is kept — scene capture depends on it', () => {
  assert.match(block('contextOptions: {', '},'), /preserveDrawingBuffer:\s*true/);
});

test('the low-power cockpit canvas is left alone', () => {
  // A secondary decorative canvas deliberately asks for low-power; forcing the
  // discrete GPU there would burn battery for a cloud effect.
  const cockpit = fs.readFileSync(new URL('./cockpitCloudEffects.js', import.meta.url), 'utf8');
  assert.match(cockpit, /powerPreference:\s*'low-power'/);
});
