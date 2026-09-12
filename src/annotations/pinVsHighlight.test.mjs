/**
 * A pin and a highlight must not look the same.
 *
 * The voice schema sells them as two different things —
 *   "pin = planted marker at a spot;
 *    highlight = pulsing ring drawing the eye to a point"
 * — and the model picks between them on that description. But both renderers
 * branched only on `type !== 'label'`, so pin and highlight produced identical
 * markup: the same pulsing ring, the same dot. Two same-coloured marks were
 * indistinguishable, and asking for a highlight to call attention to one of
 * several pins changed nothing on screen.
 *
 * The distinction, using only the vocabulary already here:
 *   highlight  pulsing beacon ring   — the attention-getter
 *   pin        the same ring, steady — planted, definite, does not throb
 *   label      no ring at all        — caption only
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const screenSrc = readFileSync(path.join(dir, 'screenAnnotationRenderer.js'), 'utf8');
const worldSrc = readFileSync(path.join(dir, 'worldAnnotationRenderer.js'), 'utf8');

/** The branch that draws point-shaped marks (pin / highlight / label). */
function pointBranch(source) {
  const start = source.indexOf('pin / highlight / label');
  assert.notEqual(start, -1, 'point-mark branch not found — did the renderer move?');
  return source.slice(start, start + 2200);
}

/** The condition both renderers use to mean "this one is the attention-getter". */
const BEACON_FROM_TYPE = /beacon\s*=\s*anno\.type === 'highlight'/;

test('the screen renderer separates the beacon from the planted marker', () => {
  assert.match(
    pointBranch(screenSrc),
    BEACON_FROM_TYPE,
    'the screen point branch never distinguishes highlight, so a pin and a '
    + 'highlight render identically — the schema promises they differ',
  );
});

test('only the highlight pulses on screen', () => {
  const pulseLine = pointBranch(screenSrc).split('\n').find((l) => l.includes('gev-pulse'));
  assert.ok(pulseLine, 'no pulsing element in the point branch');
  assert.match(
    pulseLine,
    /beacon/,
    'the pulsing class is applied unconditionally, so a pin throbs like a beacon '
    + 'when the schema calls it a planted marker',
  );
});

test('the world renderer pulses only for the highlight', () => {
  const branch = pointBranch(worldSrc);
  assert.match(branch, BEACON_FROM_TYPE, 'the world point branch does not derive a beacon condition');
  const pulseLine = branch.split('\n').find((l) => l.includes('pulse:'));
  assert.ok(pulseLine, 'no pulse option in the world point branch');
  assert.match(
    pulseLine,
    /beacon/,
    'the ground ring pulses for every point mark, so pin and highlight are the '
    + 'same object at every altitude',
  );
});

test('label stays the quietest of the three', () => {
  // Guarding the existing hierarchy: whatever pin becomes, a label must still
  // be the caption-only form with no ring.
  assert.match(pointBranch(screenSrc), /type !== 'label'/);
  assert.match(pointBranch(worldSrc), /type !== 'label'/);
});
