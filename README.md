# claude-code-ctx

[![npm version](https://img.shields.io/npm/v/claude-code-ctx.svg)](https://www.npmjs.com/package/claude-code-ctx)
[![license](https://img.shields.io/npm/l/claude-code-ctx.svg)](LICENSE)
[![node](https://img.shields.io/node/v/claude-code-ctx.svg)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-123%20passing-brightgreen.svg)](src/test)
[![deps](https://img.shields.io/badge/deps-0-brightgreen.svg)](package.json)

> **Claude Code context manager + personal dev memory engine.**
> Token monitoring, auto-snapshot before `/clear`, tailored `/compact` prompt, ranked search across past sessions, system-prompt bloat audit, MCP tools that wrap heavy commands and cache their output, PreToolUse guardrails that catch risky Bash before it floods context.
>
> **Zero runtime dependencies. No LLM calls. Pure Node 18+.**

> 📦 **Package name:** `claude-code-ctx` (npm) / `claude-code-ctx@claude-code-ctx` (Claude Code plugin)
> 💻 **CLI binary:** `ctx` (short, what you type in terminal)
> 🪝 **Slash commands:** `/ctx-doctor`, `/ctx-ask`, … (20 commands, see below)

---

## What it does

Three layers stacked on Claude Code's hook + MCP systems:

**Hooks (event-driven).**
- **SessionStart** auto-injects the most recent snapshot — new sessions don't start from zero after `/clear`.
- **Stop** at urgent+ level: writes a snapshot, gzips the full JSONL to `~/.config/ctx/backups/`, and copies a tailored `/compact` prompt to your clipboard. You paste with `⌘V`.
- **PreCompact** adds focus/keep/drop guidance so `/compact` preserves the right stuff.
- **PreToolUse** on Bash: catches `find /`, `ls -R`, unbounded `grep -r`, `cat /var/log/…` and similar, tells Claude to narrow scope before the command runs.
- **PostToolUse** on Bash: every `git commit` triggers a snapshot (`trigger: commit` in frontmatter).
- **UserPromptSubmit** on the first 1–2 prompts of a session: runs ranked search across past snapshots and injects the best match as `additionalContext`. Claude "remembers" how you solved X last time.

**MCP server (Claude-initiated).** ctx exposes 9 tools Claude can call during a conversation:
- `ctx_ask`, `ctx_timeline`, `ctx_stats`, `ctx_snapshot`, `ctx_heavy` — memory/audit
- `ctx_shell`, `ctx_read`, `ctx_grep` — wrappers that summarize + cache oversized output
- `ctx_cache_get` — paginate cached output by ref

When Claude would otherwise run `Bash("find / -name X")` and get 500 KB back, it calls `ctx_shell` instead: full output is stored in `~/.config/ctx/mcp-cache/<ref>.txt`, context gets a 2 KB summary + ref. Same idea as context-mode, built without SQLite or native deps.

**CLI + 20 slash commands (user-initiated).** `/ctx-ask`, `/ctx-timeline`, `/ctx-doctor`, `/ctx-report`, etc. — all shell out to the same CLI.

---

## Install

Two paths.

### Recommended: Claude Code plugin

```bash
git clone https://github.com/tugayoktayokay/claude-code-ctx ~/tools/claude-code-ctx
```

Then inside any Claude Code session:

```
/plugin marketplace add /Users/you/tools/claude-code-ctx
/plugin install claude-code-ctx@claude-code-ctx
```

Or via GitHub (same effect):

```
/plugin marketplace add tugayoktayokay/claude-code-ctx
/plugin install claude-code-ctx@claude-code-ctx
```

Claude Code reads `.claude-plugin/plugin.json`, registers 6 hooks + MCP server + 20 slash commands automatically. Manage with `/plugin list`, `/plugin disable ctx`, `/plugin update ctx`.

### Alternative: npm + manual setup

```bash
npm install -g claude-code-ctx
ctx setup         # writes hooks + MCP entry into ~/.claude/settings.json
ctx status        # verify
```

Both paths coexist without conflict. Plugin path auto-updates; npm path needs `ctx upgrade`. If you installed both, `ctx status` warns and `ctx uninstall-hooks` clears the manual copy.

### Migrating from 0.3.0

Version 0.4.0 renames the plugin identifier from `ctx` to `claude-code-ctx` so it matches the npm package + marketplace. If you installed 0.3.0:

```
/plugin uninstall ctx@claude-code-ctx
/plugin install claude-code-ctx@claude-code-ctx
```

Slash commands (`/ctx-ask`, `/ctx-doctor`, …) and the CLI binary (`ctx`) are unchanged.

---

## Slash commands (inside Claude Code)

| command | does |
|---|---|
| `/ctx-doctor` | health check (hooks, config, daemon, plugin install) |
| `/ctx-status` | install state + latest snapshot + latest backup |
| `/ctx-analyze` | current session: token %, metrics, recommendation |
| `/ctx-ask <query>` | ranked snapshot search (BM25 + category + recency) |
| `/ctx-timeline` | threaded parent-chain history |
| `/ctx-stats` | weekly snapshot/trigger/category aggregate |
| `/ctx-heavy` | largest tool outputs in this session + tool-specific hints |
| `/ctx-bloat` | CLAUDE.md + SKILL.md footprint, flag unused skills |
| `/ctx-usage [--tools\|--skills]` | aggregate usage across recent sessions |
| `/ctx-compact` | build tailored /compact prompt, copy to clipboard |
| `/ctx-snapshot [name]` | manual checkpoint |
| `/ctx-report [path]` | self-contained HTML report |
| `/ctx-restore [id]` | list / restore gzipped JSONL backups |
| `/ctx-prune [--apply]` | memory dir cleanup |
| `/ctx-purge [--apply]` | delete this project's memory + backups |
| `/ctx-upgrade` | git pull latest source |
| `/ctx-history [N]` | last N sessions across all projects |
| `/ctx-config` | show config paths |
| `/ctx-diff <a.md> <b.md>` | snapshot delta |
| `/ctx-file <path>` | analyze a specific JSONL |

---

## CLI (terminal)

```bash
ctx                          # analyze current session
ctx watch                    # live foreground monitor
ctx daemon start|stop|status # background watcher + macOS notifications
ctx ask "<query>" [--global] [--notes] [--inject] [--json]
ctx compact                  # tailored /compact prompt → clipboard
ctx snapshot [--name N]      # manual snapshot
ctx timeline                 # threaded history
ctx diff <a> <b>             # snapshot delta
ctx stats [--week|--month]   # aggregation
ctx heavy                    # largest outputs in current session
ctx bloat                    # system-prompt footprint audit
ctx usage --tools --days 30  # tool usage across sessions
ctx report --out file.html   # self-contained HTML report
ctx restore --list           # list JSONL backups
ctx prune [--apply]          # memory dir cleanup
ctx doctor                   # 9 health checks
ctx status                   # install + config state
```

---

## Memory engine

Past snapshots are not a write-only archive. ctx ranks them with a BM25 hybrid (IDF + category overlap + recency decay, Porter-lite stemming, Levenshtein fuzzy fallback) and Claude's UserPromptSubmit hook auto-retrieves the best match for your first 1–2 prompts of a new session — so you pick up where you left off instead of re-explaining context.

**Explicit recall** via `ctx ask` / `/ctx-ask`:
```
ctx ask "stripe webhook"
  # → top 3 snapshots with score breakdown (category/keyword/recency)
ctx ask "auth flow" --global
  # → across all projects
ctx ask "design doc" --notes
  # → also scans config-declared markdown roots (Obsidian, ~/notes, …)
```

**Auto-inject** via hook: on the first 1–2 prompts of a session, if a past snapshot scores ≥ `min_score` (default 0.3), ctx injects it as `additionalContext`. Every injection is logged to `~/.config/ctx/hooks.log` — fully transparent.

**Timeline + diff:** `ctx timeline` threads snapshots by `parent:` pointer so you see a project's evolution. `ctx diff <a> <b>` shows what files/decisions/failed attempts changed between two snapshots.

**Bloat audit:** `ctx bloat` scans `~/.claude/CLAUDE.md`, your project `CLAUDE.md`, and every installed `SKILL.md` (across all plugins) — reports per-file description byte cost, flags skills not invoked in the last N days. Reducing unused skills is the cheapest token win.

---

## Configuration

`~/.config/ctx/config.json` (deep-merged over `config.default.json`). Key sections:

```json
{
  "limits": {
    "models": {
      "claude-opus-4-7":   { "max": 1000000, "quality_ceiling": 200000 },
      "claude-sonnet-4-6": { "max": 200000,  "quality_ceiling": 200000 },
      "claude-haiku-4-5":  { "max": 200000,  "quality_ceiling": 100000 }
    },
    "thresholds": { "compact": 0.55, "urgent": 0.75, "critical": 0.90 }
  },
  "hooks": {
    "session_start": { "restore_latest": true, "max_bytes": 8192 },
    "stop":          { "snapshot_on": ["urgent","critical"], "backup_on": ["critical"], "clipboard_compact_on": ["compact","urgent","critical"] },
    "pre_compact":   { "inject_guidance": true, "respect_user_input": true },
    "pre_tool_use":  { "enabled": true, "default_mode": "ask", "rules": [ ... 9 default patterns ... ] },
    "post_tool_use": { "triggers": [{"tool":"Bash","match":"^git commit","action":"snapshot"}] },
    "user_prompt_submit": {
      "warn_on": [],
      "heavy_threshold_bytes": 10000,
      "auto_retrieve": { "enabled": true, "max_turns": 2, "min_score": 0.3, "scopes": ["project","global"] }
    }
  },
  "backup": { "keep_last": 10, "dir": "~/.config/ctx/backups" },
  "retrieval": { "weights": { "category": 0.5, "keyword": 0.3, "recency": 0.2 }, "min_score": 0.15, "top_n": 3 },
  "notes":  { "roots": [], "exclude": ["node_modules",".git","dist","build"] }
}
```

---

## What ctx deliberately does *not* do

- **Write to `CLAUDE.md`.** Your architecture docs are yours; ctx never touches them. Snapshots go only into `~/.claude/projects/<cwd>/memory/`.
- **Auto-type `/clear` or `/compact`.** Slash commands are user actions; Claude Code exposes no API for us to simulate them. ctx makes them frictionless (`/compact` prompt already in clipboard, `/clear` safe because SessionStart restores) but you still press the keys.
- **Call an LLM.** All inference is regex, BM25 math, Porter-lite stemming, Levenshtein distance. No `@anthropic-ai/*`, no embeddings service, no API key needed.
- **Overwrite your own hooks or MCP servers.** Install is tag-based (`source: "ctx"`). Uninstall removes only ctx-tagged entries. Foreign entries are preserved.
- **Fire time-based alerts.** Triggers are state-driven (threshold crossings, git commits, Stop events) — never "N minutes elapsed".
- **Require native deps.** No `better-sqlite3`, no Python, no Bun. Clone the repo and it runs on any Node 18+.

---

## Testing

```bash
node --test src/test/*.test.js
```

123 tests across 17 files: session parsing, analyzer, decision thresholds, compact strategy, snapshot writing + fingerprint dedup, pipeline extraction, hooks (all 7 events), hooks install/uninstall, backup round-trip + rotation, prune + MEMORY.md rewrite, retrieval (BM25 + stemming + fuzzy), notes walker, timeline chain traversal, diff, stats, optimize (bloat + usage + heavy), report HTML generation, MCP protocol (initialize + tools/list + tools/call + cancellation + validation + empty-list methods + progress + CRLF), MCP cache round-trip, MCP tool handlers.

---

## Architecture

See `CLAUDE.md` for module boundaries. Summary: one-way data flow through pure-ish modules, `cli.js` dispatches, `pipeline.runAnalyze` is the shared entry point from cwd to analysis+decision+strategy.

Key modules:
- `session.js` — JSONL + cwd encoding
- `analyzer.js` — entries → stats (tokens, files, categories, decisions, failed attempts, large outputs)
- `decision.js` — stats + limits → level/action
- `strategy.js` — tailored `/compact` prompt
- `snapshot.js` — markdown + frontmatter (parent, categories, fingerprint, trigger)
- `query.js` + `retrieval.js` + `notes.js` — BM25 ranked search over snapshots + user notes
- `timeline.js`, `diff.js`, `stats.js`, `optimize.js` — memory engine analytics
- `hooks.js` + `hooks_install.js` — hook handlers + settings.json merge
- `mcp.js` + `mcp_tools.js` + `mcp_cache.js` — JSON-RPC server, 9 tools, TTL cache
- `doctor.js`, `report.js`, `backup.js`, `prune.js` — operator commands

---

## License

MIT — see [LICENSE](LICENSE).
