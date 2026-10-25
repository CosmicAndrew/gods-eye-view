// With no Overpass endpoint configured (the deployed default since upstream
// stopped using public Overpass), area annotations still trace a real outline
// from the configured outline source instead of collapsing to a point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_SOURCE_METHODS } from '../sources/featureSource.js';
import { createAnnotationResolver } from './resolver.js';

function viewerAt(lat, lon, height = 3000) {
  return {
    camera: {
      positionCartographic: {
        latitude: (lat * Math.PI) / 180,
        longitude: (lon * Math.PI) / 180,
        height,
      },
    },
  };
}

const UNCONFIGURED = {
  code: 'OVERPASS_NOT_CONFIGURED',
  retryable: false,
  unavailable: true,
};

// Central Park's real extent, roughly: a 4 km x 0.8 km box.
const PARK_RING = [
  [-73.9819, 40.7681],
  [-73.958, 40.8003],
  [-73.9493, 40.7968],
  [-73.973, 40.7644],
  [-73.9819, 40.7681],
];

function harness({ outline }) {
  const featureSource = {};
  for (const method of FEATURE_SOURCE_METHODS)
    featureSource[method] = async () => UNCONFIGURED;
  const outlineCalls = [];
  const outlineSource = async (query) => {
    outlineCalls.push(query);
    return outline;
  };
  const placeSearch = {
    async geocode() {
      return {
        place: {
          lat: 40.7829,
          lng: -73.9654,
          name: 'Central Park',
          label: 'Central Park, New York',
          types: ['park', 'point_of_interest'],
        },
      };
    },
    async textSearch() {
      return [];
    },
  };
  const { resolveAnnotationTarget } = createAnnotationResolver({
    featureSource,
    outlineSource,
  });
  const resolve = async (target) => {
    const anchor = await resolveAnnotationTarget({
      placeSearch,
      viewer: viewerAt(40.7829, -73.9654),
      target,
      entityKind: 'compound',
      footprint: true,
      deferFootprint: true,
    });
    return { anchor, outline: await anchor?.resolveOutline?.() };
  };
  return { resolve, outlineCalls };
}

test('an unconfigured Overpass falls back to the outline source', async () => {
  const { resolve, outlineCalls } = harness({
    outline: { ring: PARK_RING, kind: 'area', name: 'Central Park' },
  });
  const { anchor, outline } = await resolve('Central Park, New York');
  assert.ok(anchor, 'anchor resolved');
  assert.equal(outlineCalls.length, 1, 'outline source consulted');
  assert.match(outlineCalls[0].query, /Central Park/);
  assert.ok(outline?.ring?.length >= 4, 'traced ring returned');
  assert.equal(outline.footprintKind, 'area');
  assert.equal(outline.synthesized, false);
  assert.ok(Math.abs(outline.lat - 40.782) < 0.02, 'recentred on the park');
});

// "Highlight the perimeter of the property" at a house drew a ~50 m tinted
// column: a building footprint renders as an extruded volume. A fallback
// outline carries no height, so it is always drawn flat on the ground.
test('a building outline from the fallback is drawn on the ground', async () => {
  const { resolve } = harness({
    outline: { ring: PARK_RING, kind: 'building', name: 'House' },
  });
  const { outline } = await resolve('Central Park, New York');
  assert.ok(outline?.ring?.length >= 4);
  assert.equal(outline.footprintKind, 'area');
});

test('no fallback outline keeps the honest unavailable result', async () => {
  const { resolve } = harness({ outline: null });
  const { outline } = await resolve('Central Park, New York');
  assert.equal(outline?.code, 'OVERPASS_NOT_CONFIGURED');
});

test('a fallback outline far from the anchor is rejected', async () => {
  const shifted = PARK_RING.map(([lon, lat]) => [lon + 3, lat + 3]);
  const { resolve } = harness({ outline: { ring: shifted, kind: 'area' } });
  const { outline } = await resolve('Central Park, New York');
  assert.equal(outline?.ring, undefined, 'wrong-place ring not drawn');
});
