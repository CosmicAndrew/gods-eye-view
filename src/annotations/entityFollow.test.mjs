// Moving things are highlightable: a mark on an aircraft, ship or satellite
// rides along with it instead of staying where it was first seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotationEngine } from './annotationEngine.js';

function engineWith(locateEntity, t) {
  const prior = globalThis.requestAnimationFrame;
  const priorCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const engine = createAnnotationEngine({
    viewer: {},
    renderer: {
      add() {},
      update() {},
      remove() {},
      sync() {},
      destroy() {},
    },
    resolveTarget: async () => null,
    locateEntity,
    followIntervalMs: 5,
  });
  t.after(() => {
    engine.destroy();
    globalThis.requestAnimationFrame = prior;
    globalThis.cancelAnimationFrame = priorCancel;
  });
  return engine;
}

test('a highlight on an aircraft follows it', async (t) => {
  let lon = -97.7;
  const asked = [];
  const engine = engineWith((query, layerId) => {
    asked.push([query, layerId]);
    return { id: 'a1b2c3', layerId: 'flights', label: 'UAL12', lat: 30.2, lon, height: 9000 };
  }, t);
  const result = await engine.annotate([
    { type: 'area', entity: 'UAL12', layerId: 'flights' },
  ]);
  assert.equal(result.drawn, 1);
  const [mark] = engine.list();
  assert.equal(mark.type, 'highlight');
  assert.equal(mark.label, 'UAL12');
  assert.equal(mark.anchor.height, 9000);
  lon = -97.6;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(engine.list()[0].anchor.lon, -97.6);
  // Later lookups use the stable id, not the spoken name.
  assert.deepEqual(asked.at(-1), ['a1b2c3', 'flights']);
});

test('an entity that is not on the map fails honestly', async (t) => {
  const engine = engineWith(() => null, t);
  const result = await engine.annotate([{ type: 'highlight', entity: 'NOPE1' }]);
  assert.equal(result.drawn, 0);
  assert.match(result.results[0].error, /aircraft, ship or satellite/);
});
