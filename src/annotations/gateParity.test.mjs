/**
 * The anchor gate and the footprint gate must agree on when to stand down.
 *
 * The resolver checks the proximity bound twice: once on the geocoded anchor,
 * and again on the centroid of the traced footprint ("Same drift bound as the
 * anchor gate", by its own comment). If only the first learns a new bypass, the
 * two disagree and the result is the worst of both — the point is trusted and
 * placed, then its own outline is thrown away for being exactly as far from the
 * camera as the point we just accepted.
 *
 * That is not hypothetical: it is what "outline the Presidio" did from a camera
 * over Austin once the anchor bypass landed. The mark appeared, the perimeter
 * never did, and nothing reported an error.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'annotationResolver.js'),
  'utf8',
);

/** Every guard that decides whether the shared drift bound applies. */
function gateLines() {
  // The anchor gate puts its gateDrift() call on the following line, so key on
  // the condition both guards share rather than on the call itself.
  return source.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('if (fromGeocode &&'));
}

test('both proximity gates exist', () => {
  assert.equal(gateLines().length, 2, 'expected an anchor gate and a footprint gate');
});

test('both gates honour the same bypasses', () => {
  const [anchor, footprint] = gateLines().map((l) => l.trim());
  for (const bypass of ['bypassNearViewGuards', 'echoesTheAsk']) {
    assert.ok(anchor.includes(bypass), `anchor gate lost ${bypass}`);
    assert.ok(
      footprint.includes(bypass),
      `footprint gate does not honour ${bypass}, so a trusted anchor keeps its point `
      + `and silently loses its outline:\n  anchor:    ${anchor}\n  footprint: ${footprint}`,
    );
  }
});
