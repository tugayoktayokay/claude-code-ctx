'use strict';

const fs   = require('fs');
const path = require('path');
const { resolveMemoryDir } = require('./snapshot.js');
const { buildThreads } = require('./timeline.js');
const { aggregate } = require('./stats.js');
const { scanClaudeMd, findUnusedSkills, aggregateToolUsage, listSessionsInRange } = require('./optimize.js');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024)        return (n / 1024).toFixed(1) + ' KB';
  return `${n} B`;
}

function timeAgoShort(ms) {
  const d = Date.now() - ms;
  const m = Math.round(d / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function generateReport({ cwd, config, days = 30 }) {
  const memoryDir = resolveMemoryDir(cwd, config);
  const threads   = buildThreads(memoryDir);
  const stats7    = aggregate(memoryDir, { rangeDays: 7 });
  const stats30   = aggregate(memoryDir, { rangeDays: 30 });
  const claudeMd  = scanClaudeMd(cwd);
  const skillRep  = findUnusedSkills({ scanThresholdDays: days });
  const toolUsage = aggregateToolUsage(listSessionsInRange(days));

  const data = {
    generatedAt: new Date().toISOString(),
    cwd,
    memoryDir,
    stats7,
    stats30,
    threads,
    claudeMd,
    skills: {
      installed: skillRep.installed.length,
      unused: skillRep.unused.length,
      unusedBytes: skillRep.unused.reduce((a, s) => a + (s.descBytes || 0), 0),
      top: skillRep.installed.slice(0, 20),
      unusedList: skillRep.unused.slice(0, 20),
    },
    tools: {
      scanned: toolUsage.scanned,
      top: toolUsage.ranked.slice(0, 20),
    },
  };

  const threadHtml = data.threads.map((thr, i) => {
    const last = thr[thr.length - 1];
    const rows = thr.map(s =>
      `<tr><td class="date">${new Date(s.mtime).toISOString().slice(0, 10)}</td>` +
      `<td class="name">${escapeHtml(s.name)}</td>` +
      `<td class="cats">${escapeHtml((s.categories || []).join(', ') || '-')}</td></tr>`
    ).join('');
    return `<div class="thread"><h3>Thread #${i + 1} · ${thr.length} snapshots · last ${timeAgoShort(last.mtime)}</h3>` +
      `<table>${rows}</table></div>`;
  }).join('\n') || '<p class="empty">No snapshots in this project yet.</p>';

  const triggerRows = (s) => Object.entries(s.triggers).map(([k, v]) =>
    `<tr><td class="k">${escapeHtml(k)}</td><td class="v">${v}</td></tr>`
  ).join('') || '<tr><td class="empty" colspan="2">none</td></tr>';

  const categoryRows = (s) => s.topCategories.map(c =>
    `<tr><td class="k">${escapeHtml(c.name)}</td><td class="v">${c.count}</td></tr>`
  ).join('') || '<tr><td class="empty" colspan="2">none</td></tr>';

  const toolRows = data.tools.top.map(t =>
    `<tr><td class="k">${escapeHtml(t.name)}</td><td class="v">${t.count}</td></tr>`
  ).join('') || '<tr><td class="empty" colspan="2">none</td></tr>';

  const unusedRows = data.skills.unusedList.map(s =>
    `<tr><td class="name">${escapeHtml(s.name)}</td>` +
    `<td class="size">${fmtBytes(s.descBytes || 0)}</td>` +
    `<td class="desc">${escapeHtml(s.description || '')}</td></tr>`
  ).join('') || '<tr><td class="empty" colspan="3">all skills used in window</td></tr>';

  const claudeMdBlocks = data.claudeMd.map(cmd => {
    const secRows = cmd.topSections.map(s =>
      `<tr><td class="k">${escapeHtml(s.heading)}</td><td class="v">${fmtBytes(s.bytes)}</td></tr>`
    ).join('');
    return `<div class="claudemd"><h4>${escapeHtml(cmd.path)} · ${fmtBytes(cmd.bytes)}</h4>` +
      `<table>${secRows}</table></div>`;
  }).join('\n') || '<p class="empty">No CLAUDE.md found</p>';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>ctx report · ${escapeHtml(path.basename(cwd))}</title>
<meta name="color-scheme" content="light dark">
<style>
  :root {
    --bg: #fff; --fg: #111; --muted: #666; --border: #e5e5e5; --accent: #0b7; --warn: #d90;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #111; --fg: #eee; --muted: #999; --border: #2a2a2a; --accent: #7fe; --warn: #fd7; }
  }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, system-ui, Segoe UI, sans-serif; margin: 0; padding: 2rem; background: var(--bg); color: var(--fg); max-width: 1100px; margin: 0 auto; }
  header { border-bottom: 1px solid var(--border); padding-bottom: 1rem; margin-bottom: 2rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.6rem; }
  .meta { color: var(--muted); font-size: 13px; }
  section { margin-bottom: 3rem; }
  h2 { font-size: 1.15rem; border-bottom: 1px solid var(--border); padding-bottom: 0.3rem; }
  h3 { font-size: 1rem; margin: 1.5rem 0 0.5rem; color: var(--accent); }
  h4 { margin: 0.8rem 0 0.4rem; font-size: 0.95rem; font-family: ui-monospace, monospace; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
  .big { font-size: 2rem; font-weight: 600; color: var(--accent); }
  .big.warn { color: var(--warn); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 0.3rem 0.6rem; border-bottom: 1px solid var(--border); }
  td.v, td.size { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
  td.date { white-space: nowrap; color: var(--muted); }
  td.name { font-family: ui-monospace, monospace; font-size: 12px; }
  td.desc { color: var(--muted); font-size: 12px; }
  td.empty { color: var(--muted); font-style: italic; text-align: center; }
  .thread { margin-bottom: 1rem; }
  .empty { color: var(--muted); font-style: italic; }
  code { font-family: ui-monospace, monospace; font-size: 12px; background: var(--border); padding: 1px 4px; border-radius: 3px; }
  footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
</style></head><body>

<header>
  <h1>ctx report</h1>
  <div class="meta">
    <code>${escapeHtml(data.cwd)}</code> · generated ${escapeHtml(data.generatedAt)}
  </div>
</header>

<section>
  <h2>At a glance</h2>
  <div class="grid">
    <div class="card"><div class="big">${data.stats7.snapshots}</div><div>snapshots (last 7 days)</div></div>
    <div class="card"><div class="big">${data.stats30.snapshots}</div><div>snapshots (last 30 days)</div></div>
    <div class="card"><div class="big">${data.threads.length}</div><div>snapshot threads</div></div>
    <div class="card"><div class="big ${data.skills.unused > 20 ? 'warn' : ''}">${data.skills.unused}</div><div>unused skills (${days}d)</div></div>
  </div>
</section>

<section>
  <h2>Snapshot timeline</h2>
  ${threadHtml}
</section>

<section>
  <h2>Triggers & categories</h2>
  <div class="grid">
    <div class="card">
      <h3>Triggers — last 7 days</h3>
      <table><thead><tr><th>trigger</th><th>count</th></tr></thead><tbody>${triggerRows(data.stats7)}</tbody></table>
    </div>
    <div class="card">
      <h3>Top categories — last 30 days</h3>
      <table><thead><tr><th>category</th><th>count</th></tr></thead><tbody>${categoryRows(data.stats30)}</tbody></table>
    </div>
  </div>
</section>

<section>
  <h2>Tool usage (last ${days}d, ${data.tools.scanned} sessions scanned)</h2>
  <div class="card">
    <table><thead><tr><th>tool</th><th>calls</th></tr></thead><tbody>${toolRows}</tbody></table>
  </div>
</section>

<section>
  <h2>System prompt footprint</h2>
  <h3>CLAUDE.md files</h3>
  ${claudeMdBlocks}
  <h3>Unused skills — removing saves ~${fmtBytes(data.skills.unusedBytes)} of description bytes per session</h3>
  <div class="card">
    <table><thead><tr><th>skill</th><th>desc</th><th>description</th></tr></thead><tbody>${unusedRows}</tbody></table>
  </div>
</section>

<footer>
  Generated by <code>ctx report</code> · self-contained, no network, no tracking.
</footer>

</body></html>
`;
}

module.exports = { generateReport };
