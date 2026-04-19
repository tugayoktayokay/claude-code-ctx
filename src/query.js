'use strict';

function tokenize(str) {
  if (!str) return [];
  return String(str)
    .toLowerCase()
    .replace(/['’](?:u|un|ün|in|yi|yı|yu|yü|a|e|da|de|den|dan|ta|te|ya|ye)\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function filterStopwords(tokens, stopwords) {
  const set = new Set([...(stopwords?.tr || []), ...(stopwords?.en || [])]);
  return tokens.filter(t => !set.has(t));
}

function categorize(tokens, categories) {
  const text = tokens.join(' ');
  const out = [];
  for (const [key, cat] of Object.entries(categories || {})) {
    const words = cat.words || [];
    if (words.some(w => text.includes(w.toLowerCase()))) out.push(key);
  }
  return out;
}

function makeQuery(raw, config) {
  const tokens  = tokenize(raw);
  const nonStop = filterStopwords(tokens, config?.stopwords || {});
  const categories = categorize(nonStop, config?.categories || {});
  return { raw, tokens, nonStop, categories };
}

module.exports = { tokenize, filterStopwords, categorize, makeQuery };
