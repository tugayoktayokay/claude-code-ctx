'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { projectDirFor } = require('./session.js');

function slugify(str, maxLen = 40) {
  return String(str)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen) || 'session';
}

function deriveName(analysis, categories) {
  const topCat = [...analysis.activeCategories.entries()]
    .sort((a, b) => b[1].count - a[1].count)[0];
  const topKey = topCat ? topCat[0] : 'session';
  const last = analysis.lastNMessages[analysis.lastNMessages.length - 1] || '';
  const lastSlug = slugify(last, 30);
  const base = lastSlug ? `${topKey}_${lastSlug}` : topKey;
  return slugify(base, 50);
}

function describeCategories(analysis, categories) {
  const top = [...analysis.activeCategories.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .map(([k]) => categories?.[k]?.label || k);
  return top;
}

function computeFingerprint(analysis, decision) {
  const files = [...analysis.filesModified].slice(-8).sort().join('|');
  const decisions = analysis.decisions.slice(0, 5).join('|');
  const lastIntent = analysis.lastNMessages.slice(-1)[0] || '';
  const tokenBucket = Math.floor((decision?.metrics?.contextTokens || 0) / 5000);
  const msgBucket   = Math.floor((analysis?.messageCount || 0) / 5);
  const canonical = `${files}\n${decisions}\n${lastIntent}\n${tokenBucket}\n${msgBucket}`;
  return crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

function readRecentFingerprints(memoryDir, limit = 3) {
  if (!fs.existsSync(memoryDir)) return [];
  let names;
  try { names = fs.readdirSync(memoryDir); } catch { return []; }
  const files = [];
  for (const name of names) {
    if (!name.startsWith('project_') || !name.endsWith('.md')) continue;
    const full = path.join(memoryDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    files.push({ name, path: full, mtime: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const head = files.slice(0, Math.min(50, limit * 3));
  const out = [];
  for (const f of head) {
    if (out.length >= limit) break;
    try {
      const first = fs.readFileSync(f.path, 'utf8').split('\n', 20);
      let fingerprint = null;
      for (const line of first) {
        const m = line.match(/^fingerprint:\s*([a-f0-9]+)\s*$/);
        if (m) { fingerprint = m[1]; break; }
      }
      out.push({ ...f, fingerprint });
    } catch {}
  }
  return out;
}

function getLatestSnapshotForCwd(cwd, config) {
  const memoryDir = resolveMemoryDir(cwd, config);
  const recent = readRecentFingerprints(memoryDir, 1);
  return recent[0] || null;
}

function buildMarkdown(analysis, decision, strategy, options) {
  const { name, categories, sessionId, modelId, trigger, fingerprint, parent, categoryKeys } = options;
  const topLabels = describeCategories(analysis, categories);
  const lastIntent = analysis.lastNMessages[analysis.lastNMessages.length - 1] || '';
  const today = new Date().toISOString().slice(0, 10);

  const description = [
    topLabels.slice(0, 2).join(' + ') || 'session snapshot',
    lastIntent ? `last: "${lastIntent.slice(0, 50)}"` : null,
  ].filter(Boolean).join(' — ');

  const filesList = [...analysis.filesModified]
    .slice(-12)
    .map(f => `- ${path.basename(f)} (${f})`)
    .join('\n');

  const decisions = analysis.decisions.slice(0, 5)
    .map(d => `- ${d.replace(/\n/g, ' ').slice(0, 140)}`)
    .join('\n');

  const failed = analysis.failedAttempts.slice(0, 5)
    .map(d => `- ${d.replace(/\n/g, ' ').slice(0, 120)}`)
    .join('\n');

  const critBits = [...new Set(analysis.criticalBits.map(c => c.type))].join(', ');

  const whyLine = topLabels.length
    ? `Active topics: ${topLabels.join(', ')}.`
    : `Saved for session continuity.`;

  const howLine = [
    analysis.filesModified.size
      ? `${analysis.filesModified.size} files modified — reference them when continuing`
      : null,
    lastIntent ? `last task: "${lastIntent.slice(0, 60)}"` : null,
    analysis.failedAttempts.length ? 'do not repeat failed attempts' : null,
  ].filter(Boolean).join('; ');

  const sections = [];
  sections.push(`---`);
  sections.push(`name: ${name}`);
  sections.push(`description: ${description}`);
  sections.push(`type: project`);
  if (sessionId)   sections.push(`originSessionId: ${sessionId}`);
  if (modelId)     sections.push(`model: ${modelId}`);
  if (trigger)     sections.push(`trigger: ${trigger}`);
  if (fingerprint) sections.push(`fingerprint: ${fingerprint}`);
  if (categoryKeys && categoryKeys.length) sections.push(`categories: [${categoryKeys.join(', ')}]`);
  if (parent)      sections.push(`parent: ${parent}`);
  sections.push(`---`);
  sections.push(``);
  sections.push(`In-progress work (${today}):`);
  sections.push(``);

  if (lastIntent) {
    sections.push(`**Last task:** "${lastIntent.slice(0, 160)}"`);
    sections.push(``);
  }

  if (filesList) {
    sections.push(`**Modified files (${analysis.filesModified.size}):**`);
    sections.push(filesList);
    sections.push(``);
  }

  if (decisions) {
    sections.push(`**Decisions made:**`);
    sections.push(decisions);
    sections.push(``);
  }

  if (failed) {
    sections.push(`**Failed attempts / open questions:**`);
    sections.push(failed);
    sections.push(``);
  }

  if (critBits) {
    sections.push(`**Critical signal types:** ${critBits}`);
    sections.push(``);
  }

  sections.push(`**Context snapshot:**`);
  sections.push(
    `- ${decision.metrics.contextPct}% of ${kFmt(decision.metrics.qualityCeiling)} (${kFmt(decision.metrics.contextTokens)} tokens)`
  );
  sections.push(
    `- ${analysis.messageCount} messages, ${analysis.toolUses} tool calls, ${analysis.filesModified.size} files modified`
  );
  if (analysis.avgGrowthPerTurn > 0) {
    sections.push(`- Growth ~${kFmt(analysis.avgGrowthPerTurn)}/turn`);
  }
  sections.push(``);

  sections.push(`**Why:** ${whyLine}`);
  sections.push(`**How to apply:** ${howLine || 'continue this session from where it left off'}`);
  sections.push(``);

  return sections.join('\n');
}

function kFmt(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function resolveMemoryDir(cwd, config) {
  const template = config?.snapshot?.memory_dir || '{project_dir}/memory';
  const projectDir = projectDirFor(cwd);
  return template
    .replace('{project_dir}', projectDir)
    .replace(/^~/, process.env.HOME || '');
}

function updateIndex(indexPath, relFile, description) {
  const line = `- [${relFile.replace(/\.md$/, '')}](${relFile}) — ${description}`;
  let existing = '';
  if (fs.existsSync(indexPath)) {
    existing = fs.readFileSync(indexPath, 'utf8');
    const escaped = relFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\]\\(${escaped}\\)`).test(existing)) {
      return false;
    }
  }
  const newContent = existing.endsWith('\n') || !existing
    ? existing + line + '\n'
    : existing + '\n' + line + '\n';
  fs.writeFileSync(indexPath, newContent);
  return true;
}

function writeSnapshot(analysis, decision, strategy, options) {
  const { cwd, config, customName, sessionId, modelId, trigger } = options;
  const memoryDir = resolveMemoryDir(cwd, config);
  fs.mkdirSync(memoryDir, { recursive: true });

  const fingerprint = computeFingerprint(analysis, decision);

  const dedupWindow = config?.snapshot?.dedup_window_n ?? 3;
  if (options.dedupCheck !== false && dedupWindow > 0) {
    const recent = readRecentFingerprints(memoryDir, dedupWindow);
    if (recent.some(r => r.fingerprint === fingerprint)) {
      return { outPath: null, indexUpdated: false, filename: null, dedupHit: true, fingerprint };
    }
  }

  const categories = config?.categories || {};
  const derived = customName
    ? slugify(customName, 60)
    : deriveName(analysis, categories);
  const fileBase = `project_${derived}`;
  let filename = `${fileBase}.md`;
  let counter = 2;
  while (fs.existsSync(path.join(memoryDir, filename))) {
    filename = `${fileBase}_${counter}.md`;
    counter++;
  }

  const parent = (() => {
    const recent = readRecentFingerprints(memoryDir, 1);
    return recent[0] ? recent[0].name : null;
  })();
  const categoryKeys = [...analysis.activeCategories.keys()];

  const name = `ctx snapshot — ${derived.replace(/_/g, ' ')}`;
  const markdown = buildMarkdown(analysis, decision, strategy, {
    name,
    categories,
    sessionId,
    modelId,
    trigger: trigger || 'manual',
    fingerprint,
    parent,
    categoryKeys,
  });

  const outPath = path.join(memoryDir, filename);
  fs.writeFileSync(outPath, markdown);

  let indexUpdated = false;
  if (config?.snapshot?.auto_index_update !== false) {
    const indexPath = path.join(memoryDir, 'MEMORY.md');
    const top = describeCategories(analysis, categories);
    const lastIntent = analysis.lastNMessages[analysis.lastNMessages.length - 1] || '';
    const idxDesc = [
      top.slice(0, 2).join(' + ') || 'snapshot',
      lastIntent ? `last: "${lastIntent.slice(0, 40)}"` : null,
    ].filter(Boolean).join(' — ');
    indexUpdated = updateIndex(indexPath, filename, idxDesc);
  }

  return { outPath, indexUpdated, filename, fingerprint, dedupHit: false };
}

function rewriteIndex(indexPath, removedFilenames) {
  if (!fs.existsSync(indexPath)) return { removed: 0 };
  const existing = fs.readFileSync(indexPath, 'utf8');
  const toRemove = new Set(removedFilenames);
  const lines = existing.split('\n');
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    const m = line.match(/^- \[project_[^\]]+\]\(([^)]+)\)/);
    if (m && toRemove.has(m[1])) {
      removed++;
      continue;
    }
    kept.push(line);
  }
  fs.writeFileSync(indexPath, kept.join('\n'));
  return { removed };
}

module.exports = {
  slugify,
  deriveName,
  buildMarkdown,
  resolveMemoryDir,
  writeSnapshot,
  updateIndex,
  rewriteIndex,
  computeFingerprint,
  readRecentFingerprints,
  getLatestSnapshotForCwd,
};
