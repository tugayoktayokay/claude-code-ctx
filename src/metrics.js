'use strict';

const fs = require('fs');

const EVENT_TYPES = ['pre_tool', 'post_tool', 'cache-write', 'cache-read', 'cache-gc'];

// Legitimate hook events emitted by pre-v0.7 ctx (and by other hook actions like
// session-start/stop/auto-retrieve/pre-compact). They are not consumed by metrics.js
// but they are not malformed either — skip silently instead of counting them as
// parse errors.
const IGNORED_EVENT_TYPES = new Set([
  'session-start',
  'stop',
  'pre-compact',
  'pre-tool-use',
  'post-tool-use',
  'auto-retrieve',
  'hook',
]);

function parseLine(line) {
  // Returns { record, error } — record is null if line is malformed or silently skipped.
  if (!line.trim()) return { record: null, error: null };
  const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+(\S+)\s*(.*)$/);
  if (!tsMatch) return { record: null, error: 'no timestamp' };
  const [, ts, evType, rest] = tsMatch;
  if (IGNORED_EVENT_TYPES.has(evType)) return { record: null, error: null };
  if (!EVENT_TYPES.includes(evType)) return { record: null, error: 'unknown event type' };
  const kv = parseKeyValues(rest);
  return { record: { ts, evType, ...kv }, error: null };
}

function parseKeyValues(rest) {
  // Handles key=bareword and key="quoted with spaces and \"escaped\" quotes".
  const out = {};
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i])) i++;
    if (i >= rest.length) break;
    const keyMatch = rest.slice(i).match(/^([a-zA-Z_][a-zA-Z0-9_]*)=/);
    if (!keyMatch) break;
    const key = keyMatch[1];
    i += keyMatch[0].length;
    if (rest[i] === '"') {
      i++;
      let value = '';
      while (i < rest.length) {
        // Only unescape \" → " and \\ → \. Leave \s, \+, \d etc. literal — they are
        // regex patterns in rule.match and must survive the round-trip unchanged.
        if (rest[i] === '\\' && (rest[i + 1] === '"' || rest[i + 1] === '\\')) {
          value += rest[i + 1]; i += 2; continue;
        }
        if (rest[i] === '"') { i++; break; }
        value += rest[i]; i++;
      }
      out[key] = value;
    } else {
      const m = rest.slice(i).match(/^(\S+)/);
      out[key] = m ? m[1] : '';
      i += (m ? m[0].length : 0);
    }
  }
  return out;
}

function parseLogPath(pathStr) {
  return parseLogString(fs.readFileSync(pathStr, 'utf8'));
}

function parseLogString(content) {
  const records = [];
  let parseErrors = 0;
  for (const line of content.split('\n')) {
    const { record, error } = parseLine(line);
    if (record) records.push(record);
    else if (error) parseErrors++;
  }
  return { records, parseErrors };
}

function parseLog(input) {
  if (Buffer.isBuffer(input)) return parseLogString(String(input));
  if (typeof input !== 'string') throw new TypeError('parseLog requires a path string, Buffer, or raw content string');
  // If it exists as a file, read it. Otherwise treat as raw content.
  // Guard against huge strings being stat-checked.
  if (input.length < 4096 && fs.existsSync(input)) return parseLogPath(input);
  return parseLogString(input);
}

// Verified against Claude Code plugin MCP on 2026-04-21:
// ctx plugin tools emit tool_name as mcp__ctx__ctx_<grep|read|shell>.
// Verified against real Claude Code PostToolUse payload on 2026-04-22:
// - Plugin-installed: tool_name = "mcp__plugin_claude-code-ctx_ctx__ctx_grep"
// - Direct MCP (if user adds to .mcp.json): "mcp__ctx__ctx_grep"
// Both forms must match so metrics work regardless of install method.
const CTX_MCP_TOOL_RE = /^mcp__(?:plugin_claude-code-ctx_)?ctx__ctx_(grep|read|shell)$/;
const WINDOW_SECONDS_DEFAULT = 60;

function toMs(ts) { return Date.parse(ts); }

function correlate(records, { windowSeconds = WINDOW_SECONDS_DEFAULT } = {}) {
  const bySession = new Map();
  for (const r of records) {
    if (!r.session) continue;
    if (!bySession.has(r.session)) bySession.set(r.session, []);
    bySession.get(r.session).push(r);
  }

  const result = {
    deny:  { total: 0, obeyed: 0, bypassed: 0, bypass_failed: 0, abandoned: 0 },
    ask:   { total: 0, user_approved: 0, redirected: 0, canceled: 0, approved_failed: 0 },
    per_rule: new Map(),
    unscoped: 0,
  };

  for (const [sid, events] of bySession.entries()) {
    events.sort((a, b) => toMs(a.ts) - toMs(b.ts));
    if (sid === '-') {
      result.unscoped += events.length;
      continue;
    }
    const closed = new Set();
    for (let i = 0; i < events.length; i++) {
      const pre = events[i];
      if (pre.evType !== 'pre_tool') continue;
      if (pre.action !== 'deny' && pre.action !== 'ask') continue;

      const bucket = pre.action === 'deny' ? result.deny : result.ask;
      bucket.total++;
      const patt = pre.pattern || '';
      if (!result.per_rule.has(patt)) result.per_rule.set(patt, { triggers: 0, bypasses: 0 });
      result.per_rule.get(patt).triggers++;

      const preMs = toMs(pre.ts);
      let classification = null;
      for (let j = i + 1; j < events.length; j++) {
        const post = events[j];
        if (post.evType !== 'post_tool') continue;
        if (closed.has(j)) continue;
        const dt = (toMs(post.ts) - preMs) / 1000;
        if (dt > windowSeconds) break;
        const isBashPost = post.tool === 'Bash';
        const isCtxPost  = CTX_MCP_TOOL_RE.test(post.tool || '');
        if (!isBashPost && !isCtxPost) continue; // bystander — skip
        closed.add(j);
        // exit='-' means unknown (Bash payload doesn't expose exit_code in real Claude
        // Code PostToolUse — only `interrupted`). Treat unknown as success (bypassed),
        // only non-zero numeric exit (e.g. 124 from interrupted=true) as failure.
        const exitStr = String(post.exit ?? '-');
        const exitNum = Number(exitStr);
        const exitKnown = Number.isFinite(exitNum);
        if (isBashPost && (!exitKnown || exitNum === 0)) {
          classification = pre.action === 'deny' ? 'bypassed' : 'user_approved';
          if (pre.action === 'deny') result.per_rule.get(patt).bypasses++;
        } else if (isBashPost && exitKnown && exitNum !== 0) {
          classification = pre.action === 'deny' ? 'bypass_failed' : 'approved_failed';
        } else if (isCtxPost) {
          classification = pre.action === 'deny' ? 'obeyed' : 'redirected';
        }
        break;
      }
      if (!classification) {
        classification = pre.action === 'deny' ? 'abandoned' : 'canceled';
      }
      bucket[classification]++;
    }
  }

  const per_rule = Array.from(result.per_rule.entries())
    .map(([pattern, v]) => ({
      pattern,
      triggers: v.triggers,
      bypasses: v.bypasses,
      bypass_rate: v.triggers ? v.bypasses / v.triggers : 0,
    }))
    .sort((a, b) => b.bypass_rate - a.bypass_rate || b.bypasses - a.bypasses)
    .slice(0, 10);

  return {
    pre_tool: {
      total: result.deny.total + result.ask.total,
      deny: result.deny,
      ask:  result.ask,
    },
    per_rule,
    unscoped: result.unscoped,
  };
}

const MS_PER_DAY = 24 * 3600 * 1000;

function withinRange(ts, now, rangeDays) {
  const cutoff = now - rangeDays * MS_PER_DAY;
  return toMs(ts) >= cutoff;
}

function aggregateCache(records) {
  let writes = 0, reads = 0, read_hits = 0, read_misses = 0;
  let gc_sweeps = 0, gc_evicted = 0, gc_bytes_freed = 0;
  for (const r of records) {
    if (r.evType === 'cache-write') writes++;
    else if (r.evType === 'cache-read') {
      reads++;
      if (r.result === 'hit') read_hits++;
      else if (r.result === 'miss') read_misses++;
    } else if (r.evType === 'cache-gc') {
      gc_sweeps++;
      gc_evicted     += Number(r.swept || 0);
      gc_bytes_freed += Number(r.bytes_freed || 0);
    }
  }
  const hit_rate = reads ? read_hits / reads : 0;
  return { writes, reads, read_hits, read_misses, hit_rate, gc_sweeps, gc_evicted, gc_bytes_freed };
}

function aggregate(logPath, { now = Date.now(), rangeDays = 7, windowSeconds = 60 } = {}) {
  const { records, parseErrors } = parseLog(logPath);
  const inRange = records.filter(r => withinRange(r.ts, now, rangeDays));
  const corr = correlate(inRange, { windowSeconds });
  const cache = aggregateCache(inRange);
  return {
    range_days: rangeDays,
    window_seconds: windowSeconds,
    pre_tool: corr.pre_tool,
    per_rule: corr.per_rule,
    cache,
    unscoped: corr.unscoped,
    parse_errors: parseErrors,
  };
}

module.exports = { parseLine, parseKeyValues, parseLog, parseLogPath, parseLogString, EVENT_TYPES, IGNORED_EVENT_TYPES, correlate, CTX_MCP_TOOL_RE, aggregate, aggregateCache };
