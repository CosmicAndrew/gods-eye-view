/**
 * RFC 7235 permits optional whitespace between the auth-scheme and its
 * credentials, so `Basic  <token>` is a valid header. Splitting on a single
 * space made the credentials empty and rejected it - a lockout of a conforming
 * client, found by an independent review of this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { basicAuthGate } from './basicAuthGate.js';

function handlerFor(creds) {
  const handlers = [];
  basicAuthGate(creds).configurePreviewServer({ middlewares: { use: (...a) => handlers.push(a[a.length - 1]) } });
  return handlers[0];
}

async function run(handler, authorization) {
  const req = { headers: authorization === undefined ? {} : { authorization }, url: '/', method: 'GET' };
  const res = {
    statusCode: 200, headers: {}, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end() { this.ended = true; },
  };
  let next = false;
  await handler(req, res, () => { next = true; });
  return next;
}

const token = Buffer.from('andrew:pw').toString('base64');
const gate = () => handlerFor({ user: 'andrew', password: 'pw' });

test('a single space between scheme and credentials is accepted', async () => {
  assert.equal(await run(gate(), `Basic ${token}`), true);
});

test('extra whitespace between scheme and credentials is still accepted', async () => {
  for (const header of [`Basic  ${token}`, `Basic   ${token}`, `Basic\t${token}`]) {
    assert.equal(await run(gate(), header), true, `rejected valid header: ${JSON.stringify(header)}`);
  }
});

test('surrounding whitespace does not break the header', async () => {
  assert.equal(await run(gate(), `  Basic ${token}  `), true);
});

test('whitespace tolerance does not let a wrong password through', async () => {
  const wrong = Buffer.from('andrew:nope').toString('base64');
  assert.equal(await run(gate(), `Basic   ${wrong}`), false);
});

test('a scheme with no credentials at all is still rejected', async () => {
  for (const header of ['Basic', 'Basic ', 'Basic    ', '']) {
    assert.equal(await run(gate(), header), false, `accepted empty credentials: ${JSON.stringify(header)}`);
  }
});

test('a token containing no colon is still rejected', async () => {
  assert.equal(await run(gate(), `Basic  ${Buffer.from('nocolon').toString('base64')}`), false);
});
