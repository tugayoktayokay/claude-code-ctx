'use strict';

const fs = require('fs');

const EVENT_TYPES = ['pre_tool', 'post_tool', 'cache-write', 'cache-read', 'cache-gc'];

function parseLine(line) {
  // Returns { record, error } — record is null if line is malformed.
  if (!line.trim()) return { record: null, error: null }; // blank line: skip
  const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+(\S+)\s*(.*)$/);
  if (!tsMatch) return { record: null, error: 'no timestamp' };
  const [, ts, evType, rest] = tsMatch;
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
        if (rest[i] === '\\' && rest[i + 1] !== undefined) { value += rest[i + 1]; i += 2; continue; }
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

module.exports = { parseLine, parseKeyValues, parseLog, parseLogPath, parseLogString, EVENT_TYPES };
