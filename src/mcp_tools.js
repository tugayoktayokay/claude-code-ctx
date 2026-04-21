'use strict';

const fs     = require('fs');
const path   = require('path');
const { spawnSync, spawn } = require('child_process');
const { makeQuery } = require('./query.js');
const {
  collectProjectCandidates,
  collectAllProjectsCandidates,
  rank,
} = require('./retrieval.js');
const { CLAUDE_DIR } = require('./session.js');
const {
  resolveMemoryDir,
  writeSnapshot,
  getLatestSnapshotForCwd,
} = require('./snapshot.js');
const { buildThreads } = require('./timeline.js');
const { aggregate }    = require('./stats.js');
const { runAnalyze }   = require('./pipeline.js');
const cache            = require('./mcp_cache.js');

function okText(text) {
  return text;
}

const memoryTools = [
  {
    name: 'ctx_ask',
    description: 'Search the user\'s past Claude Code session snapshots (ranked by category + BM25 + recency). Use when the user references previous work, or at the start of a task to check for prior context. Returns top N snapshots with their key decisions and last intent.',
    inputSchema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Natural language or keyword query.' },
        scope:   { type: 'string', enum: ['project', 'global'], description: 'project = current cwd only, global = all projects.' },
        top_n:   { type: 'integer', minimum: 1, maximum: 10, description: 'Max results (default 3).' },
      },
      required: ['query'],
    },
    handler: async (args, { config }) => {
      const cwd = process.cwd();
      const q = makeQuery(String(args.query || ''), config);
      const candidates = (args.scope === 'global')
        ? collectAllProjectsCandidates(CLAUDE_DIR, config)
        : collectProjectCandidates(resolveMemoryDir(cwd, config), config);
      const cfg = { ...config, retrieval: { ...config.retrieval, top_n: args.top_n || 3 } };
      const results = rank(q, candidates, cfg);
      if (!results.length) return okText('no matches');
      const lines = [`query: ${q.raw}  tokens: ${q.nonStop.join(' ')}  cats: ${q.categories.join(', ') || '-'}`];
      for (const r of results) {
        const fp = (r.snapshot.meta?.fingerprint || '').slice(0, 8);
        const preview = (r.snapshot.body || '').split('\n').filter(Boolean).slice(0, 6).join('\n');
        lines.push('');
        lines.push(`#${fp || r.snapshot.name}  score ${r.score.toFixed(2)}  cats: ${(r.snapshot.categories || []).join(', ') || '-'}`);
        lines.push(`  path: ${r.snapshot.path}`);
        lines.push(preview);
      }
      return okText(lines.join('\n'));
    },
  },
  {
    name: 'ctx_timeline',
    description: 'Return the threaded timeline of snapshot files in the current project (parent-chain grouping). Use when the user asks about recent work or project evolution.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'global'], description: 'project = current cwd only.' },
      },
    },
    handler: async (args, { config }) => {
      const cwd = process.cwd();
      const memoryDir = resolveMemoryDir(cwd, config);
      const threads = buildThreads(memoryDir);
      if (!threads.length) return okText('no snapshots yet');
      const out = [];
      threads.slice(0, 10).forEach((thread, i) => {
        const last = thread[thread.length - 1];
        const ageMin = Math.round((Date.now() - last.mtime) / 60000);
        out.push(`thread #${i + 1} — ${thread.length} snapshot(s), last ${ageMin}m ago`);
        for (const s of thread.slice(-5)) {
          const d = new Date(s.mtime).toISOString().slice(0, 10);
          out.push(`  ${d}  ${s.name}  cats: ${(s.categories || []).join(', ') || '-'}`);
        }
      });
      return okText(out.join('\n'));
    },
  },
  {
    name: 'ctx_stats',
    description: 'Aggregated snapshot statistics for the current project: count, triggers breakdown, top categories over a time range.',
    inputSchema: {
      type: 'object',
      properties: {
        range_days: { type: 'integer', minimum: 1, maximum: 365 },
      },
    },
    handler: async (args, { config }) => {
      const cwd = process.cwd();
      const memoryDir = resolveMemoryDir(cwd, config);
      const s = aggregate(memoryDir, { rangeDays: args.range_days || 7 });
      const triggerLines = Object.entries(s.triggers).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none)';
      const catLines     = s.topCategories.map(c => `  ${c.name}: ${c.count}`).join('\n') || '  (none)';
      return okText([
        `snapshots in last ${s.rangeDays}d: ${s.snapshots}`,
        'triggers:', triggerLines,
        'top categories:', catLines,
      ].join('\n'));
    },
  },
  {
    name: 'ctx_snapshot',
    description: 'Write a manual snapshot now for the current session. Useful at natural checkpoints (feature complete, before risky refactor, etc).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional custom name for the snapshot file.' },
      },
    },
    handler: async (args, { config }) => {
      const cwd = process.cwd();
      const pipe = runAnalyze({ cwd, config });
      if (!pipe) return okText('no active session to snapshot');
      const result = writeSnapshot(pipe.analysis, pipe.decision, pipe.strategy, {
        cwd,
        config,
        customName: args.name || null,
        sessionId: pipe.sessionId,
        modelId: pipe.modelId,
        trigger: 'mcp:manual',
      });
      if (result.dedupHit) return okText('snapshot skipped (dedup hit, identical to recent)');
      return okText(`snapshot written: ${result.outPath}`);
    },
  },
  {
    name: 'ctx_heavy',
    description: 'List the largest tool outputs in the CURRENT session, with tool-specific advice on how to narrow scope.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, { config }) => {
      const cwd = process.cwd();
      const pipe = runAnalyze({ cwd, config });
      if (!pipe) return okText('no active session');
      const items = (pipe.analysis.largeOutputs || []).slice().sort((a, b) => b.size - a.size).slice(0, 10);
      if (!items.length) return okText('no heavy outputs in current session');
      const lines = items.map(i => `${Math.round(i.size / 1024).toString().padStart(5)} KB  ${i.tool.padEnd(20)}  ${i.hint || ''}`);
      return okText(lines.join('\n'));
    },
  },
];

function parseByteLimit(v, fallback) {
  if (typeof v === 'number') return v;
  return fallback;
}

const wrapperTools = [
  {
    name: 'ctx_shell',
    description: 'Run a shell command. Returns inline if output <limit_bytes (default 5000), otherwise a ~500B summary plus a ref — full output cached, paginate via ctx_cache_get({ref,offset,limit}). **Use instead of raw Bash** for anything likely to produce >5KB: find, grep -r, ls -R, tree, journalctl, docker logs, du -a, large git log. Raw Bash dumps everything into context; this returns a summary.',
    inputSchema: {
      type: 'object',
      properties: {
        command:      { type: 'string', description: 'Shell command to run.' },
        cwd:          { type: 'string', description: 'Working directory (defaults to user cwd).' },
        limit_bytes:  { type: 'integer', description: 'Return inline if output under this (default 5000).' },
        timeout_ms:   { type: 'integer', description: 'Kill after this many ms (default 30000).' },
      },
      required: ['command'],
    },
    handler: async (args, { config, signal, sendProgress } = {}) => {
      const command    = String(args.command || '');
      const cwd        = args.cwd || process.cwd();
      const limitBytes = parseByteLimit(args.limit_bytes, 5000);
      const timeoutMs  = args.timeout_ms || 30000;

      return new Promise((resolve) => {
        const child = spawn(command, {
          shell: true,
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let cancelled = false;
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
        }, timeoutMs);

        const onAbort = () => {
          cancelled = true;
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort);
        }

        const progressTimer = sendProgress ? setInterval(() => {
          sendProgress(stdout.length + stderr.length);
        }, 1000) : null;

        child.stdout.on('data', (c) => {
          stdout += c.toString();
          if (stdout.length > 50 * 1024 * 1024) {
            try { child.kill('SIGTERM'); } catch {}
          }
        });
        child.stderr.on('data', (c) => { stderr += c.toString(); });

        child.on('close', (code, sig) => {
          clearTimeout(timer);
          if (progressTimer) clearInterval(progressTimer);
          if (signal) { try { signal.removeEventListener('abort', onAbort); } catch {} }

          const combined = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
          const status = cancelled ? 'cancelled'
                       : timedOut  ? 'timeout'
                       : sig       ? `signal ${sig}`
                       : code == null ? 'killed'
                       : `exit ${code}`;

          if (cancelled) {
            resolve(okText('cancelled'));
            return;
          }

          if (combined.length <= limitBytes) {
            resolve(okText(`[ctx_shell ${status}, ${combined.length}B]\n${combined}`));
            return;
          }

          const cached = cache.writeCache(combined, { gc: (config && config.cache && config.cache.gc) || {} });
          const summary = cache.summarizeLines(combined, { head: 25, tail: 10 });
          resolve(okText([
            `[ctx_shell ${status}, ${combined.length}B → summarized]`,
            `ref: ${cached.ref}  (ctx_cache_get ref="${cached.ref}" offset=0 limit=4000 to read chunks)`,
            '',
            summary,
          ].join('\n')));
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          if (progressTimer) clearInterval(progressTimer);
          resolve(okText(`error: ${err.message}`));
        });
      });
    },
  },
  {
    name: 'ctx_read',
    description: 'Read a file. Returns inline if <limit_bytes (default 5000), otherwise head+tail summary + cached ref. **Use instead of raw cat/Read** for files >5KB, especially logs, generated output, or large JSON. Paginate full content via ctx_cache_get.',
    inputSchema: {
      type: 'object',
      properties: {
        path:         { type: 'string' },
        offset:       { type: 'integer', description: 'Byte offset to start at.' },
        limit_bytes:  { type: 'integer', description: 'Return inline if under this (default 5000).' },
      },
      required: ['path'],
    },
    handler: async (args, { config }) => {
      const filePath   = String(args.path || '');
      const offset     = args.offset || 0;
      const limitBytes = parseByteLimit(args.limit_bytes, 5000);

      if (!fs.existsSync(filePath)) return okText(`error: not found: ${filePath}`);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return okText(`error: not a file: ${filePath}`);

      const content = fs.readFileSync(filePath, 'utf8');
      const slice = offset > 0 ? content.slice(offset) : content;

      if (slice.length <= limitBytes) {
        return okText(`[ctx_read ${filePath}, ${slice.length}B]\n${slice}`);
      }

      const cached = cache.writeCache(content, { gc: (config && config.cache && config.cache.gc) || {} });
      const summary = cache.summarizeLines(slice, { head: 30, tail: 10 });
      return okText([
        `[ctx_read ${filePath}, ${content.length}B → summarized]`,
        `ref: ${cached.ref}  (ctx_cache_get to read chunks)`,
        '',
        summary,
      ].join('\n'));
    },
  },
  {
    name: 'ctx_grep',
    description: 'Run grep with a pattern + path. Returns matches inline if <limit_bytes (default 5000), otherwise summary + cached ref. **Use instead of raw `grep -r`** — same semantics, safe against huge codebases. Paginate via ctx_cache_get.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern:     { type: 'string' },
        path:        { type: 'string', description: 'File or directory to search.' },
        max_results: { type: 'integer', description: 'Hard cap (default 100).' },
        glob:        { type: 'string', description: 'Optional glob filter.' },
      },
      required: ['pattern'],
    },
    handler: async (args, { config }) => {
      const pattern    = String(args.pattern || '');
      const searchPath = args.path || process.cwd();
      const maxResults = args.max_results || 100;

      const rgArgs = ['-n', '--max-count', String(maxResults), pattern, searchPath];
      if (args.glob) { rgArgs.splice(0, 0, '--glob', args.glob); }

      let result;
      try {
        result = spawnSync('rg', rgArgs, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 20000 });
      } catch (err) {
        return okText(`error: rg not available (${err.message})`);
      }
      if (result.error) {
        const grep = spawnSync('grep', ['-rn', '-m', String(maxResults), pattern, searchPath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 20000 });
        result = grep;
      }

      const stdout = result.stdout || '';
      const stderr = result.stderr || '';
      if (!stdout && !stderr) return okText('[ctx_grep] no matches');

      if (stdout.length <= 5000) {
        return okText(`[ctx_grep ${stdout.split('\n').filter(Boolean).length} matches]\n${stdout}`);
      }

      const cached = cache.writeCache(stdout, { gc: (config && config.cache && config.cache.gc) || {} });
      const summary = cache.summarizeLines(stdout, { head: 40, tail: 5 });
      return okText([
        `[ctx_grep ${stdout.length}B of matches → summarized]`,
        `ref: ${cached.ref}`,
        '',
        summary,
      ].join('\n'));
    },
  },
  {
    name: 'ctx_cache_get',
    description: 'Retrieve a chunk of cached output from a prior ctx_shell/ctx_read/ctx_grep call by its ref. Use offset/limit to page through.',
    inputSchema: {
      type: 'object',
      properties: {
        ref:    { type: 'string' },
        offset: { type: 'integer' },
        limit:  { type: 'integer', description: 'Max bytes to return (default 4000).' },
      },
      required: ['ref'],
    },
    handler: async (args, { config: _config }) => {
      const r = cache.readCache(String(args.ref || ''), { offset: args.offset || 0, limit: args.limit || 4000 });
      if (r.error === 'not-found') return okText(`error: cache miss (expired or invalid ref)`);
      return okText([
        `[ctx_cache_get ref=${args.ref} offset=${r.offset} returned=${r.returned}B of ${r.total}B total]`,
        '',
        r.content,
      ].join('\n'));
    },
  },
];

function allTools() {
  return [...memoryTools, ...wrapperTools];
}

module.exports = {
  memoryTools,
  wrapperTools,
  allTools,
};
