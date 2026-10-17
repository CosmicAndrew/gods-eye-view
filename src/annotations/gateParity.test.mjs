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

// The resolver body moved from annotationResolver.js (now a thin adapter) to
// resolver.js in upstream's application-services split.
const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'resolver.js'),
  'utf8',
);

/** Every guard that decides whether the shared drift bound applies. */
function gateLines() {
  // Prettier wraps a long condition across lines, so read each guard's whole
  // condition with whitespace collapsed rather than one physical line. Key on
  // the condition both guards share rather than on the gateDrift() call.
  const flat = source.replace(/\s+/g, ' ');
  return [...flat.matchAll(/if \( ?fromGeocode &&[^{;]*?\)\s*(?:\{|return)/g)].map((m) => m[0]);
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
