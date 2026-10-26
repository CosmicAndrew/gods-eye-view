// /api/geocode/outline: Nominatim polygon hits become one drawable ring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickNominatimOutline,
  createNominatimOutlineProvider,
} from '../../server/providers/regional/place.js';

const square = (lon, lat, d = 0.01) => [
  [lon - d, lat - d],
  [lon + d, lat - d],
  [lon + d, lat + d],
  [lon - d, lat + d],
  [lon - d, lat - d],
];

test('the polygon holding the anchor wins over a nearer-listed one', () => {
  const rows = [
    {
      name: 'Central Park',
      category: 'leisure',
      geojson: { type: 'Polygon', coordinates: [square(-80, 30)] },
    },
    {
      name: 'Central Park',
      category: 'leisure',
      geojson: { type: 'Polygon', coordinates: [square(-73.965, 40.782)] },
    },
  ];
  const picked = pickNominatimOutline(rows, 40.782, -73.965);
  assert.equal(picked.kind, 'area');
  assert.ok(Math.abs(picked.ring[0][0] + 73.975) < 1e-9, 'the New York park');
});

test('point hits carry no outline; multipolygons give their largest part', () => {
  assert.equal(
    pickNominatimOutline(
      [{ geojson: { type: 'Point', coordinates: [1, 2] } }],
      2,
      1,
    ),
    null,
  );
  const big = square(1, 2, 0.05);
  big.splice(2, 0, [1.05, 1.99]);
  const picked = pickNominatimOutline(
    [
      {
        category: 'building',
        geojson: { type: 'MultiPolygon', coordinates: [[square(5, 5)], [big]] },
      },
    ],
    2,
    1,
  );
  assert.equal(picked.kind, 'building');
  assert.equal(picked.ring.length, big.length);
});

test('the provider asks Nominatim for simplified polygons and caches', async () => {
  const urls = [];
  const fetchOutline = createNominatimOutlineProvider({
    requestJson: async (url) => {
      urls.push(url);
      return [
        {
          name: 'X',
          geojson: { type: 'Polygon', coordinates: [square(1, 2)] },
        },
      ];
    },
  });
  const first = await fetchOutline('x', 2, 1);
  const again = await fetchOutline('x', 2, 1);
  assert.ok(first?.ring);
  assert.equal(again, first);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /polygon_geojson=1/);
  assert.match(urls[0], /polygon_threshold=/);
});

test('a hit sharing no name word with the ask is never picked', () => {
  const rows = [
    {
      name: "Billy Bob's Texas",
      geojson: { type: 'Polygon', coordinates: [square(-97.35, 32.79)] },
    },
  ];
  assert.equal(
    pickNominatimOutline(
      rows,
      32.79,
      -97.35,
      'Fort Worth Stockyards, Fort Worth, Texas',
    ),
    null,
  );
  assert.ok(pickNominatimOutline(rows, 32.79, -97.35, "Billy Bob's"));
});

test('a road or river hit returns its centreline', () => {
  const line = [
    [-122.42, 37.8],
    [-122.41, 37.801],
    [-122.4, 37.802],
  ];
  const picked = pickNominatimOutline(
    [
      {
        name: 'Lombard Street',
        category: 'highway',
        geojson: { type: 'LineString', coordinates: line },
      },
    ],
    37.801,
    -122.41,
    'Lombard Street, San Francisco',
  );
  assert.equal(picked.kind, 'line');
  assert.equal(picked.category, 'highway');
  assert.deepEqual(picked.line, line);
  assert.equal(picked.ring, undefined);
});

test('coordinates alone reverse-look-up the feature at that spot', async () => {
  const urls = [];
  const fetchOutline = createNominatimOutlineProvider({
    requestJson: async (url) => {
      urls.push(url);
      return {
        name: '',
        category: 'building',
        geojson: { type: 'Polygon', coordinates: [square(1, 2, 0.0002)] },
      };
    },
  });
  const found = await fetchOutline('', 2, 1);
  assert.equal(found?.kind, 'building');
  assert.match(urls[0], /\/reverse\?/);
  assert.match(urls[0], /polygon_geojson=1/);
  assert.match(urls[0], /zoom=18/);
});
