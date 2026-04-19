'use strict';

const fs   = require('fs');
const path = require('path');
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

function buildMarkdown(analysis, decision, strategy, options) {
  const { name, categories, sessionId, modelId } = options;
  const topLabels = describeCategories(analysis, categories);
  const lastIntent = analysis.lastNMessages[analysis.lastNMessages.length - 1] || '';
  const today = new Date().toISOString().slice(0, 10);

  const description = [
    topLabels.slice(0, 2).join(' + ') || 'session snapshot',
    lastIntent ? `son: "${lastIntent.slice(0, 50)}"` : null,
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
    ? `Aktif konular: ${topLabels.join(', ')}.`
    : `Session devamlılığı için kaydedildi.`;

  const howLine = [
    analysis.filesModified.size
      ? `${analysis.filesModified.size} dosya değişti, devam ederken bunlara bak`
      : null,
    lastIntent ? `son görev: "${lastIntent.slice(0, 60)}"` : null,
    analysis.failedAttempts.length ? 'başarısız denemeleri tekrar etme' : null,
  ].filter(Boolean).join('; ');

  const sections = [];
  sections.push(`---`);
  sections.push(`name: ${name}`);
  sections.push(`description: ${description}`);
  sections.push(`type: project`);
  if (sessionId) sections.push(`originSessionId: ${sessionId}`);
  if (modelId)   sections.push(`model: ${modelId}`);
  sections.push(`---`);
  sections.push(``);
  sections.push(`Devam eden iş (${today}):`);
  sections.push(``);

  if (lastIntent) {
    sections.push(`**Son görev:** "${lastIntent.slice(0, 160)}"`);
    sections.push(``);
  }

  if (filesList) {
    sections.push(`**Değiştirilen dosyalar (${analysis.filesModified.size}):**`);
    sections.push(filesList);
    sections.push(``);
  }

  if (decisions) {
    sections.push(`**Alınan kararlar:**`);
    sections.push(decisions);
    sections.push(``);
  }

  if (failed) {
    sections.push(`**Başarısız / açık sorular:**`);
    sections.push(failed);
    sections.push(``);
  }

  if (critBits) {
    sections.push(`**Kritik bilgi tipleri:** ${critBits}`);
    sections.push(``);
  }

  sections.push(`**Context snapshot:**`);
  sections.push(
    `- ${decision.metrics.contextPct}% of ${kFmt(decision.metrics.qualityCeiling)} (${kFmt(decision.metrics.contextTokens)} token)`
  );
  sections.push(
    `- ${analysis.messageCount} mesaj, ${analysis.toolUses} tool çağrısı, ${analysis.filesModified.size} dosya değişti`
  );
  if (analysis.avgGrowthPerTurn > 0) {
    sections.push(`- Büyüme ~${kFmt(analysis.avgGrowthPerTurn)}/tur`);
  }
  sections.push(``);

  sections.push(`**Why:** ${whyLine}`);
  sections.push(`**How to apply:** ${howLine || 'bu session kaldığı yerden devam edilecek'}`);
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
  const { cwd, config, customName, sessionId, modelId } = options;
  const memoryDir = resolveMemoryDir(cwd, config);
  fs.mkdirSync(memoryDir, { recursive: true });

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

  const name = `ctx snapshot — ${derived.replace(/_/g, ' ')}`;
  const markdown = buildMarkdown(analysis, decision, strategy, {
    name,
    categories,
    sessionId,
    modelId,
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
      lastIntent ? `son: "${lastIntent.slice(0, 40)}"` : null,
    ].filter(Boolean).join(' — ');
    indexUpdated = updateIndex(indexPath, filename, idxDesc);
  }

  return { outPath, indexUpdated, filename };
}

module.exports = {
  slugify,
  deriveName,
  buildMarkdown,
  resolveMemoryDir,
  writeSnapshot,
  updateIndex,
};
