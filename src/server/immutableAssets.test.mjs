/**
 * `vite preview` serves content-hashed assets with `cache-control: no-cache`,
 * so every repeat visit revalidates several MB it already has. These pin the
 * fix, including the part that is easy to get wrong: the static handler sets
 * its own Cache-Control afterwards, so ours has to survive that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { immutableAssets, IMMUTABLE_CACHE_CONTROL } from './immutableAssets.js';

function install(plugin, hook = 'configurePreviewServer') {
  const handlers = [];
  plugin[hook]?.({ middlewares: { use: (...args) => handlers.push(args[args.length - 1]) } });
  return handlers;
}

/** Minimal res double that records headers the way node's does. */
function makeRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
  };
}

function run(handler, url) {
  const res = makeRes();
  let nextCalled = false;
  handler({ url, method: 'GET', headers: {} }, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('hashed assets are cached immutably for a year', () => {
  const [handler] = install(immutableAssets());
  const { res, nextCalled } = run(handler, '/assets/index-DfCP4k92.js');

  assert.equal(res.getHeader('cache-control'), IMMUTABLE_CACHE_CONTROL);
  assert.match(IMMUTABLE_CACHE_CONTROL, /immutable/);
  assert.equal(nextCalled, true, 'the asset still has to be served');
});

test('the static handler cannot downgrade the header afterwards', () => {
  const [handler] = install(immutableAssets());
  const { res } = run(handler, '/assets/index-DfCP4k92.js');

  // sirv sets its own Cache-Control after our middleware returns.
  res.setHeader('Cache-Control', 'no-cache');

  assert.equal(res.getHeader('cache-control'), IMMUTABLE_CACHE_CONTROL);
});

test('the entry HTML is never frozen', () => {
  const [handler] = install(immutableAssets());
  for (const url of ['/', '/index.html', '/?share=abc']) {
    const { res } = run(handler, url);
    assert.notEqual(res.getHeader('cache-control'), IMMUTABLE_CACHE_CONTROL, `must revalidate: ${url}`);
  }
});

test('API responses keep their own caching', () => {
  const [handler] = install(immutableAssets());
  const { res } = run(handler, '/api/opensky?lamin=30');
  res.setHeader('Cache-Control', 'no-store');

  assert.equal(res.getHeader('cache-control'), 'no-store');
});

test('an unhashed file under assets is not frozen', () => {
  const [handler] = install(immutableAssets());
  const { res } = run(handler, '/assets/logo.svg');

  assert.notEqual(res.getHeader('cache-control'), IMMUTABLE_CACHE_CONTROL);
});

test('it applies to the dev server too, not only preview', () => {
  assert.equal(install(immutableAssets(), 'configureServer').length, 1);
});
