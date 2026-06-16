'use strict';

// Fact-based memory layer (Claude-native port of codex-ctx memory.js).
// Granular, quality-scored facts stored alongside snapshots under
// <project_dir>/memory/facts/facts.jsonl. Distinct from whole-session
// snapshot blobs: a fact is one decision / constraint / workflow note.
// Zero deps; all scoring is regex/arithmetic (no LLM).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectDirFor } = require('./session.js');
const { tokenize } = require('./query.js');

const BUILTIN_GENERIC = new Set([
  'ok', 'tamam', 'evet', 'hayir', 'yes', 'no', 'devam', 'continue',
  'peki', 'olur', 'yap', 'bak', 'naber', 'thanks', 'sagol',
]);

function factDirFor(cwd, config = {}) {
  if (config && config.facts_dir) return config.facts_dir;
  const template = config?.snapshot?.memory_dir || '{project_dir}/memory';
  const memDir = template
    .replace('{project_dir}', projectDirFor(cwd))
    .replace(/^~/, process.env.HOME || '');
  return path.join(memDir, 'facts');
}

function factPathFor(cwd, config = {}) {
  return path.join(factDirFor(cwd, config), 'facts.jsonl');
}

function factId(cwd, kind, text) {
  return crypto.createHash('sha1').update(`${cwd}\n${kind}\n${text}`).digest('hex').slice(0, 20);
}

function normalizeText(text, max = 220) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// High-entropy credential shapes and key=value secrets. Applied at the
// writeFacts choke so every capture path (remember/passive/harvest) stores
// redacted text — secrets never hit facts.jsonl in plaintext.
const SECRET_TOKEN_RE = /\b(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,})\b/g;
const SECRET_KV_RE = /((?:bearer|password|api[_-]?key|secret_key|client_secret|token)\s*[:=]\s*['"]?)([A-Za-z0-9._=\-+/]{8,})/gi;
const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>|\[ctx:private\][\s\S]*?\[\/ctx:private\]/gi;

function redactSecrets(text) {
  return String(text || '')
    .replace(PRIVATE_TAG_RE, '[redacted]')
    .replace(SECRET_TOKEN_RE, '[redacted]')
    .replace(SECRET_KV_RE, '$1[redacted]');
}

function isNoisyFactText(text) {
  const t = String(text || '');
  // Hook event-log residue: require the status suffix so legit prose mentioning
  // a hook (e.g. "never block the Stop hook") is NOT misflagged as noise.
  return /\b(UserPromptSubmit|PostToolUse|PreToolUse|SessionStart|Stop)\s+hook\s*\((?:completed|blocked|failed)\)/i.test(t)
    || /\bhook context:/i.test(t)
    || /^snapshot\s+stop-/i.test(t)
    || /^\s*Base directory for this skill/i.test(t)
    || /^[╔╚║═╝╗]/.test(t);
}

function isTestLikeCommand(command) {
  const cmd = String(command || '').trim();
  return /^(?:npm|pnpm|yarn|npx|bun)\s+(?:run\s+)?(?:test|lint|build|typecheck|tsc)\b/i.test(cmd)
    || /^(?:jest|vitest|mocha|pytest|cargo\s+test|go\s+test|tsc|biome|eslint|prettier|node\s+--test)\b/i.test(cmd);
}

function factWeight(kind, text) {
  const t = String(text || '');
  let w = 1;
  if (kind === 'decision') w += 2;
  if (kind === 'error' || kind === 'guard') w += 1.5;
  if (kind === 'test') w += 1;
  if (/\b(fix|decision|decided|use|avoid|error|failed|root cause|deploy|auth|api|database|migration|karar|hata)\b/i.test(t)) w += 1;
  return w;
}

function extractPaths(text) {
  const paths = [];
  const re = /(?:^|\s)((?:\.{0,2}\/)?[\w@./-]+\.(?:js|jsx|ts|tsx|json|md|py|go|rs|css|html|sql|yml|yaml))/g;
  let m;
  while ((m = re.exec(String(text || ''))) && paths.length < 8) paths.push(m[1]);
  return [...new Set(paths)];
}

function factQuality(kind, text) {
  const t = String(text || '');
  if (isNoisyFactText(t)) return 0;
  let q = 0.4;
  if (kind === 'decision' || kind === 'bug' || kind === 'constraint' || kind === 'workflow') q += 0.35;
  if (/\b(decision|decided|use|avoid|because|root cause|fix|failed|known|must|should|prefer|karar|çünkü)\b/i.test(t)) q += 0.2;
  if (extractPaths(t).length) q += 0.1;
  if (/^(sed|nl|cat|rg|grep|tail|head)\b/i.test(t)) q -= 0.25;
  if (/bytes=\d+|\d+\s+bytes/i.test(t)) q -= 0.15;
  return Math.max(0, Math.min(1, q));
}

function readFacts(cwd, config = {}) {
  let raw = '';
  try { raw = fs.readFileSync(factPathFor(cwd, config), 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function persist(cwd, rows, config) {
  fs.mkdirSync(factDirFor(cwd, config), { recursive: true });
  fs.writeFileSync(
    factPathFor(cwd, config),
    rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
  );
}

function writeFacts(cwd, facts, config = {}) {
  const byId = new Map(readFacts(cwd, config).map(f => [f.id, f]));
  const threshold = Number(config?.memory?.prune_quality_below ?? 0.25);
  const maxFacts = Number(config?.memory?.max_facts) > 0 ? Number(config.memory.max_facts) : 1000;
  for (const raw of facts) {
    // Redact secrets at the choke point; recompute id from the cleaned text
    // so dedup keys on what is actually stored.
    const text = redactSecrets(raw.text);
    const f = text === raw.text ? raw : { ...raw, text, id: factId(raw.cwd ?? cwd, raw.kind, text), paths: extractPaths(text) };
    const prior = byId.get(f.id);
    byId.set(f.id, prior ? { ...prior, ...f, seen: Number(prior.seen || 1) + 1 } : f);
  }
  const rows = [...byId.values()]
    .filter(f => !isNoisyFactText(f.text) && Number(f.quality ?? factQuality(f.kind, f.text)) >= threshold)
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
    .slice(-maxFacts);
  persist(cwd, rows, config);
  return rows.length;
}

function rememberFact(cwd, text, config = {}, opts = {}) {
  const kind = opts.kind || 'note';
  const clean = redactSecrets(normalizeText(text, 500));
  if (!clean) return { ok: false, reason: 'empty fact' };
  const fact = {
    id: factId(cwd, kind, clean),
    cwd,
    kind,
    text: clean,
    paths: extractPaths(clean),
    source: 'manual',
    ts: opts.ts || new Date().toISOString(),
    weight: factWeight(kind, clean) + 1,
    quality: Math.max(0.8, factQuality(kind, clean)),
    seen: 1,
  };
  const total = writeFacts(cwd, [fact], config);
  return { ok: true, fact, total, path: factPathFor(cwd, config) };
}

function forgetFacts(cwd, query, config = {}, opts = {}) {
  const all = readFacts(cwd, config);
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return { before: all.length, after: all.length, removed: 0, dryRun: Boolean(opts.dryRun) };
  const mode = opts.id ? 'id' : opts.exact ? 'exact' : 'contains';
  const matches = all.filter(f => {
    const id = String(f.id || '').toLowerCase();
    const text = String(f.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (mode === 'id') return id === needle;
    if (mode === 'exact') return text === needle;
    return text.includes(needle) || id === needle;
  });
  const keep = all.filter(f => !matches.includes(f));
  if (!opts.dryRun) persist(cwd, keep, config);
  return {
    before: all.length,
    after: opts.dryRun ? all.length : keep.length,
    removed: matches.length,
    dryRun: Boolean(opts.dryRun),
    mode,
    matches: matches.slice(0, Number(opts.limit || 10)).map(f => ({ id: f.id, kind: f.kind, text: f.text })),
  };
}

function isGenericQuery(query, config = {}) {
  const normalized = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  const configured = (config?.retrieval?.generic_prompts || []).map(s => String(s).toLowerCase());
  if (configured.includes(normalized)) return true;
  const tokens = tokenize(normalized);
  if (!tokens.length) return true;
  if (tokens.length === 1 && (tokens[0].length <= 3 || BUILTIN_GENERIC.has(tokens[0]))) return true;
  return false;
}

function scoreFact(queryTokens, fact, config = {}) {
  const bodyTokens = tokenize(fact.text);
  if (!queryTokens.length || !bodyTokens.length) return 0;
  const body = new Set(bodyTokens);
  const hits = queryTokens.filter(t => body.has(t)).length;
  const coverage = hits / Math.max(1, queryTokens.length);
  const weight = Number(fact.weight || 1);
  const seenBoost = Math.min(1, Math.log2(Number(fact.seen || 1) + 1) / 4);
  const ageDays = Math.max(0, (Date.now() - Date.parse(fact.ts || 0)) / 86400000);
  const halfLife = Number(config?.memory?.recency_half_life_days || 45);
  const recency = Number.isFinite(ageDays) ? Math.pow(0.5, ageDays / Math.max(1, halfLife)) : 0;
  const quality = Number(fact.quality ?? factQuality(fact.kind, fact.text));
  return ((coverage * 4 + hits * 0.25 + seenBoost) * weight * Math.max(0.1, quality)) + 0.1 * recency;
}

function recallFacts(cwd, query, config = {}, opts = {}) {
  if (isGenericQuery(query, config)) return [];
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const wantsCache = /\b(cache|cached|ref|output|çıktı|log)\b/i.test(String(query || ''));
  const minScore = Number(opts.minScore ?? config?.memory?.min_score ?? 0.6);
  const limit = Number(opts.limit || config?.memory?.top_n || 5);
  const activePaths = new Set((opts.paths || []).map(String));
  return readFacts(cwd, config)
    .filter(f => f.kind !== 'cache' || wantsCache)
    .map(f => {
      const pathBoost = (f.paths || []).some(p => activePaths.has(p)) ? Number(config?.memory?.path_boost || 1.5) : 0;
      return { ...f, score: scoreFact(tokens, f, config) + pathBoost };
    })
    .filter(f => f.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function buildRecall(cwd, query, config = {}, opts = {}) {
  const hits = recallFacts(cwd, query, config, opts);
  if (opts.json) return JSON.stringify(hits, null, 2);
  if (!hits.length) return 'no memory facts matched';
  return hits.map((f, i) => `#${i + 1} score=${f.score.toFixed(2)} ${f.kind} ${f.ts}\n${f.text}`).join('\n\n');
}

// Only genuine decision/constraint STATEMENTS become facts. Questions and
// weak-signal chatter are skipped so passive capture doesn't flood the store
// (every captured fact also costs tokens via the SessionStart digest).
const DECISION_VERB_RE = /\b(karar|decided|decision|kullanal[ıi]m|kullanacağ[ıi]z|yapal[ıi]m|yapacağ[ıi]z|tercih ett|prefer|must|should|avoid|never|asla)\b/i;
const CONSTRAINT_RE = /\b(must|should|avoid|never|prefer|asla)\b/i;
const INTERROGATIVE_START_RE = /^(which|what|how|why|when|who|where|should|can|could|would|hangi|nas[ıi]l|neden|niye|kim|nerede|nereye)\b/i;

function looksLikeQuestion(text) {
  const t = String(text || '').trim();
  return /\?/.test(t) || INTERROGATIVE_START_RE.test(t);
}

// Passive extraction: turn a high-signal user prompt into a fact.
// Gated by config.memory.passive_prompt_extraction (default on).
function extractFromPrompt(cwd, prompt, config = {}, opts = {}) {
  if (config?.memory?.passive_prompt_extraction === false) return { extracted: 0 };
  const clean = redactSecrets(normalizeText(prompt, 260));
  if (!clean || clean.length < 12) return { extracted: 0 };
  if (isNoisyFactText(clean) || isGenericQuery(clean, config)) return { extracted: 0 };
  if (looksLikeQuestion(clean)) return { extracted: 0 };
  if (!DECISION_VERB_RE.test(clean)) return { extracted: 0 };
  const kind = CONSTRAINT_RE.test(clean) ? 'constraint' : 'decision';
  const fact = {
    id: factId(cwd, kind, clean),
    cwd,
    kind,
    text: clean,
    paths: extractPaths(clean),
    source: 'prompt',
    ts: opts.ts || new Date().toISOString(),
    weight: factWeight(kind, clean),
    quality: factQuality(kind, clean),
    seen: 1,
  };
  const total = writeFacts(cwd, [fact], config);
  return { extracted: 1, fact, total };
}

// Pull the `- ` bullet lines under a `**<header>:**` block until the next
// blank line or section header.
function sectionBullets(markdown, header) {
  const lines = String(markdown || '').split('\n');
  const out = [];
  let inSection = false;
  const headRe = new RegExp(`^\\*\\*${header.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}:?\\*\\*`, 'i');
  for (const line of lines) {
    if (headRe.test(line.trim())) { inSection = true; continue; }
    if (!inSection) continue;
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m) { out.push(m[1].trim()); continue; }
    if (line.trim() === '' || /^\*\*/.test(line.trim())) break;
  }
  return out;
}

// One-time migration: lift real decisions / failed attempts out of existing
// snapshot blobs into the granular fact store. Quality-gated + deduped by
// writeFacts, so re-running is idempotent.
function harvestSnapshots(memoryDir, cwd, config = {}, opts = {}) {
  let names = [];
  try { names = fs.readdirSync(memoryDir); } catch { return { scanned: 0, extracted: 0, total: readFacts(cwd, config).length }; }
  const harvested = [];
  const seenText = new Set(); // cross-kind, cross-file dedup of prose dumps
  let scanned = 0;
  for (const name of names) {
    if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
    let md = '';
    try { md = fs.readFileSync(path.join(memoryDir, name), 'utf8'); } catch { continue; }
    scanned++;
    const ts = opts.ts || new Date().toISOString();
    const add = (kind, raw) => {
      const text = redactSecrets(normalizeText(raw, 240));
      if (!text || text.length < 12 || isNoisyFactText(text)) return;
      // Snapshot bullets are often assistant prose, not atomic decisions:
      // drop markdown headers and overlapping decision/failed dumps.
      if (/^[#>]/.test(text)) return;
      const key = text.toLowerCase().slice(0, 120);
      if (seenText.has(key)) return;
      seenText.add(key);
      const q = factQuality(kind, text);
      if (q < Number(config?.memory?.prune_quality_below ?? 0.25)) return;
      harvested.push({
        id: factId(cwd, kind, text), cwd, kind, text,
        paths: extractPaths(text), source: 'harvest', ts,
        weight: factWeight(kind, text), quality: q, seen: 1,
      });
    };
    // Decisions first so a line shared with "Failed attempts" keeps the better kind.
    for (const d of sectionBullets(md, 'Decisions made')) add('decision', d);
    for (const f of sectionBullets(md, 'Failed attempts / open questions')) add('bug', f);
  }
  const total = writeFacts(cwd, harvested, config);
  return { scanned, extracted: harvested.length, total, path: factPathFor(cwd, config) };
}

// Highest-value durable facts (decisions/constraints/workflows/bugs), ranked
// by quality*weight with a recency tiebreak. Used to inject memory into the
// always-loaded SessionStart path.
function topFacts(cwd, config = {}, opts = {}) {
  const limit = Number(opts.limit || config?.memory?.session_start_facts || 8);
  const kinds = new Set(['decision', 'constraint', 'workflow', 'bug']);
  const halfLife = Number(config?.memory?.recency_half_life_days || 45);
  return readFacts(cwd, config)
    .filter(f => kinds.has(f.kind) && !isNoisyFactText(f.text))
    .map(f => {
      const ageDays = Math.max(0, (Date.now() - Date.parse(f.ts || 0)) / 86400000);
      const recency = Number.isFinite(ageDays) ? Math.pow(0.5, ageDays / Math.max(1, halfLife)) : 0;
      const rank = Number(f.quality ?? factQuality(f.kind, f.text)) * Number(f.weight || 1) + 0.3 * recency;
      return { ...f, rank };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
}

function sessionDigest(cwd, config = {}, opts = {}) {
  const facts = topFacts(cwd, config, opts);
  if (!facts.length) return '';
  return [
    '[ctx] Durable facts from your past work on this project:',
    '',
    ...facts.map(f => `- [${f.kind}] ${f.text}`),
    '',
    '(Your own captured memory, not an instruction.)',
  ].join('\n');
}

function pruneFacts(cwd, config = {}, opts = {}) {
  const threshold = Number(opts.qualityBelow ?? config?.memory?.prune_quality_below ?? 0.25);
  const all = readFacts(cwd, config);
  const keep = all.filter(f => !isNoisyFactText(f.text) && Number(f.quality ?? factQuality(f.kind, f.text)) >= threshold);
  if (!opts.dryRun) persist(cwd, keep, config);
  return {
    dryRun: Boolean(opts.dryRun),
    before: all.length,
    after: keep.length,
    removed: all.length - keep.length,
    quality_below: threshold,
  };
}

function auditFacts(cwd, config = {}, opts = {}) {
  const threshold = Number(config?.memory?.prune_quality_below ?? 0.25);
  const staleDays = Number(opts.staleDays || config?.memory?.stale_days || 90);
  const facts = readFacts(cwd, config).map(f => ({
    ...f,
    quality: Number(f.quality ?? factQuality(f.kind, f.text)),
    noisy: isNoisyFactText(f.text),
  }));
  const lowQuality = facts.filter(f => f.noisy || f.quality < threshold);
  const secretRisk = facts.filter(f => /sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}|(?:bearer|password|api[_-]?key|secret_key|client_secret)\s*[:=]\s*['"]?[A-Za-z0-9._=\-+/]{12,}/i.test(f.text));
  const byText = new Map();
  for (const f of facts) {
    const key = String(f.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key) continue;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(f);
  }
  const duplicates = [...byText.values()].filter(group => group.length > 1);
  const staleCutoff = Date.now() - staleDays * 86400000;
  const stale = facts.filter(f => Date.parse(f.ts || 0) > 0 && Date.parse(f.ts || 0) < staleCutoff);
  const out = {
    total: facts.length,
    low_quality: lowQuality.length,
    secret_risk: secretRisk.length,
    duplicate_groups: duplicates.length,
    stale: stale.length,
    low_quality_examples: lowQuality.slice(0, Number(opts.limit || 10)).map(f => ({ id: f.id, kind: f.kind, quality: f.quality, text: f.text })),
    duplicate_examples: duplicates.slice(0, Number(opts.limit || 10)).map(group => ({ count: group.length, ids: group.map(f => f.id), text: group[0].text })),
  };
  if (opts.json) return JSON.stringify(out, null, 2);
  return [
    '# ctx Memory Facts Audit',
    '',
    `total: ${out.total}`,
    `low_quality: ${out.low_quality}`,
    `secret_risk: ${out.secret_risk}`,
    `duplicate_groups: ${out.duplicate_groups}`,
    `stale: ${out.stale}`,
    '',
    '## Low Quality Examples',
    out.low_quality_examples.map(f => `- ${f.quality.toFixed(2)} ${f.kind} ${f.text}`).join('\n') || '- (none)',
    '',
    '## Duplicate Examples',
    out.duplicate_examples.map(f => `- x${f.count} ${f.text}`).join('\n') || '- (none)',
  ].join('\n');
}

module.exports = {
  factDirFor,
  factPathFor,
  factId,
  normalizeText,
  isNoisyFactText,
  isTestLikeCommand,
  factWeight,
  extractPaths,
  factQuality,
  redactSecrets,
  readFacts,
  writeFacts,
  rememberFact,
  forgetFacts,
  isGenericQuery,
  scoreFact,
  recallFacts,
  buildRecall,
  extractFromPrompt,
  harvestSnapshots,
  sectionBullets,
  topFacts,
  sessionDigest,
  pruneFacts,
  auditFacts,
};
