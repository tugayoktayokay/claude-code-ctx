'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { makeQuery, tokenize, filterStopwords } = require('../query.js');
const { loadDefaults } = require('../config.js');

test('tokenize lowercases and splits on non-word chars, strips clitics', () => {
  assert.deepEqual(
    tokenize("Stripe webhook'u nasıl bağlamıştık"),
    ['stripe', 'webhook', 'nasıl', 'bağlamıştık']
  );
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('foo, bar; baz.'), ['foo', 'bar', 'baz']);
});

test('filterStopwords removes tr+en stopwords', () => {
  const stopwords = { tr: ['ve', 'bir', 'için'], en: ['the', 'and', 'how'] };
  assert.deepEqual(
    filterStopwords(['stripe', 've', 'webhook', 'için'], stopwords),
    ['stripe', 'webhook']
  );
  assert.deepEqual(
    filterStopwords(['the', 'api', 'and', 'auth'], stopwords),
    ['api', 'auth']
  );
});

test('makeQuery returns tokens, nonStop, categories', () => {
  const config = loadDefaults();
  const q = makeQuery('stripe webhook kurdum', config);
  assert.ok(Array.isArray(q.tokens));
  assert.ok(Array.isArray(q.nonStop));
  assert.ok(Array.isArray(q.categories));
  assert.ok(q.categories.includes('stripe'), `expected 'stripe' in ${q.categories}`);
  assert.equal(q.raw, 'stripe webhook kurdum');
});

test('makeQuery handles empty / only-stopword input gracefully', () => {
  const config = loadDefaults();
  const q1 = makeQuery('', config);
  assert.equal(q1.nonStop.length, 0);
  assert.equal(q1.categories.length, 0);
  const q2 = makeQuery('ve bir için', config);
  assert.equal(q2.nonStop.length, 0);
});
