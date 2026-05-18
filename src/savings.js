'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const metrics = require('./metrics.js');

function tokensForBytes(bytes) {
  return Math.round((Number(bytes) || 0) / 4);
}

function estimateSavings(logPath = path.join(os.homedir(), '.config', 'ctx', 'hooks.log'), opts = {}) {
  if (!fs.existsSync(logPath)) {
    return { range_days: opts.rangeDays || 7, cache_saved_tokens: 0, wm_saved_tokens: 0, total_saved_tokens: 0, cache: {}, working_memory: {} };
  }
  const { records } = metrics.parseLog(logPath);
  const now = opts.now || Date.now();
  const rangeDays = opts.rangeDays || 7;
  const cutoff = now - rangeDays * 86_400_000;
  const inRange = records.filter(r => Date.parse(r.ts) >= cutoff);
  const cacheWrites = inRange.filter(r => r.evType === 'cache-write');
  const cacheReads = inRange.filter(r => r.evType === 'cache-read' && r.result === 'hit');
  const writeBytesByRef = new Map(cacheWrites.map(r => [r.ref, Number(r.bytes || 0)]));
  let cacheHitBytes = 0;
  for (const r of cacheReads) {
    cacheHitBytes += writeBytesByRef.get(r.ref) || Number(r.bytes || 0);
  }
  let wmBytes = 0;
  for (const r of inRange) {
    if (r.evType !== 'working_memory') continue;
    if (r.action === 'dedup_hit' || r.action === 'bash_dedup_hit') wmBytes += Number(r.bytes_saved || 0);
  }
  const cacheSavedTokens = tokensForBytes(cacheHitBytes);
  const wmSavedTokens = tokensForBytes(wmBytes);
  const cache = metrics.aggregateCache(inRange);
  const workingMemory = metrics.aggregateWorkingMemory(inRange);
  return {
    range_days: rangeDays,
    cache_hit_bytes: cacheHitBytes,
    working_memory_bytes_saved: wmBytes,
    cache_saved_tokens: cacheSavedTokens,
    wm_saved_tokens: wmSavedTokens,
    total_saved_tokens: cacheSavedTokens + wmSavedTokens,
    cache,
    working_memory: workingMemory,
  };
}

function formatSavings(s) {
  const lines = [];
  lines.push('');
  lines.push(`  ctx savings — last ${s.range_days} days`);
  lines.push('');
  lines.push(`  estimated saved: ${s.total_saved_tokens.toLocaleString()} tokens`);
  lines.push(`    cache reuse:    ${s.cache_saved_tokens.toLocaleString()} tokens (${s.cache?.read_hits || 0} hit reads / ${s.cache?.writes || 0} writes)`);
  lines.push(`    working memory: ${s.wm_saved_tokens.toLocaleString()} tokens (${(s.working_memory?.dedup_hits || 0) + (s.working_memory?.bash_dedup_hits || 0)} dedup hits)`);
  if ((s.cache?.writes || 0) > 0) {
    lines.push(`    cache reuse rate: ${Math.round(100 * (s.cache?.utilization_rate || 0))}%`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { estimateSavings, formatSavings, tokensForBytes };
