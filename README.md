# claude-code-ctx

[![npm version](https://img.shields.io/npm/v/claude-code-ctx.svg)](https://www.npmjs.com/package/claude-code-ctx)
[![plugin](https://img.shields.io/badge/Claude%20Code-plugin-blueviolet)](#install)
[![license](https://img.shields.io/npm/l/claude-code-ctx.svg)](LICENSE)
[![node](https://img.shields.io/node/v/claude-code-ctx.svg)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-174%20passing-brightgreen.svg)](src/test)
[![deps](https://img.shields.io/badge/deps-0-brightgreen.svg)](package.json)

> ## ⚠️ Prefer the Claude Code plugin install — npm is a fallback
>
> Starting with **v0.4.0**, the primary distribution is the Claude Code plugin. The npm package (`claude-code-ctx`) still works but is the secondary path: no auto-updates, no auto-registered slash commands, you must run `ctx setup` manually.
>
> **If you're installing today → use the plugin**, see [Install](#install) below.
> **If you already installed via npm → still works**, but consider migrating (`ctx uninstall-hooks` then `/plugin install claude-code-ctx@claude-code-ctx`).

---

> **Claude Code context manager + personal dev memory engine.**
> Token monitoring, auto-snapshot before `/clear`, tailored `/compact` prompt, ranked search across past sessions, system-prompt bloat audit, MCP tools that wrap heavy commands and cache their output, PreToolUse guardrails that catch risky Bash before it floods context.
>
> **Zero runtime dependencies. No LLM calls. Pure Node 18+.**

> 📦 **Package name:** `claude-code-ctx` (npm) / `claude-code-ctx@claude-code-ctx` (Claude Code plugin)
> 💻 **CLI binary:** `ctx` (short, what you type in terminal)
> 🪝 **Slash commands:** `/ctx-doctor`, `/ctx-ask`, `/ctx-metrics`, … (29 commands, see below)

---

## What it does

Three layers stacked on Claude Code's hook + MCP systems:

**Hooks (event-driven).**
- **SessionStart** auto-injects the most recent snapshot — new sessions don't start from zero after `/clear`.
- **Stop** at urgent+ level: writes a snapshot, gzips the full JSONL to `~/.config/ctx/backups/`, and copies a tailored `/compact` prompt to your clipboard. You paste with `⌘V`.
- **PreCompact** adds focus/keep/drop guidance so `/compact` preserves the right stuff.
- **PreToolUse** on Bash (21 rules as of v0.7): denies 4 unambiguously heavy patterns (`find /`, `grep -r`, `cat /var/log/`, `du -a`) with a reason pointing at the matching `ctx_shell` / `ctx_read` / `ctx_grep` wrapper; asks for 17 others (`ls -R`, `tree`, `journalctl`, `docker logs`, `kubectl logs`, `ps -ef`, `head/tail -n <big>`, `npm ls`, `git log`, `history`, plus v0.7 additions: `rg -r`, `grep -R`, `egrep -r`, `awk/sed` over files, `wc -l` on globs, `find` without `-maxdepth`). All deny/ask events are logged as parseable single-line records in `~/.config/ctx/hooks.log`.
- **PostToolUse** on every tool call (v0.7): structured event per tool invocation — `session_id`, `tool_name`, `cmd_head`, `size_bytes`, `exit` — so `ctx metrics` can correlate pre_tool decisions with what Claude actually ran. Also: `git commit` still triggers a snapshot (`trigger: commit` in frontmatter).
- **UserPromptSubmit** on the first 1–2 prompts of a session: runs ranked search across past snapshots and injects the best match as `additionalContext`. Claude "remembers" how you solved X last time.

**MCP server (Claude-initiated).** ctx exposes 9 tools Claude can call during a conversation:
- `ctx_ask`, `ctx_timeline`, `ctx_stats`, `ctx_snapshot`, `ctx_heavy` — memory/audit
- `ctx_shell`, `ctx_read`, `ctx_grep` — wrappers that summarize + cache oversized output
- `ctx_cache_get` — paginate cached output by ref

When Claude would otherwise run `Bash("find / -name X")` and get 500 KB back, it calls `ctx_shell` instead: full output is stored in `~/.config/ctx/mcp-cache/<ref>.txt`, context gets a 2 KB summary + ref. Same idea as context-mode, built without SQLite or native deps.

**BM25 search cache.** Tokenized snapshot bodies are cached at `~/.config/ctx/bm25/<encoded-cwd>.json.gz` (gzip format). Speeds up `/ctx-ask` after the first query per project. Safe to delete; rebuilds on next query.

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

### Migrating from 0.6.0 → 0.7.x

No breaking config change. Three wrinkles to know:

1. **Plugin matcher removed** from `PostToolUse` in `plugin.json`. v0.6 only captured Bash post-tool events; v0.7 captures every tool (Read, Grep, Glob, MCP, TodoWrite, …) so `ctx metrics` can see what Claude actually ran after each redirect. If you forked `plugin.json`, drop the `"matcher": "Bash"` line under `PostToolUse`.
2. **Log schema extended** with `session=<id>` on `pre_tool` and new `post_tool` / `cache-*` event types. Old pre-v0.7 log entries remain readable — `metrics.aggregate()` silently ignores `session-start`, `stop`, `pre-compact`, `pre-tool-use`, `post-tool-use`, `auto-retrieve`, and `hook` events instead of counting them as malformed.
3. **Customized rules in user config don't auto-merge.** Arrays in `~/.config/ctx/config.json` replace defaults — they don't concatenate. If you've locally customized `hooks.pre_tool_use.rules`, copy the 6 v0.7 additions from `config.default.json` manually.

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
| `/ctx-metrics` | **v0.7** — obey rate for pre_tool redirects, top bypass offenders, cache hit rate |
| `/ctx-plugin-fix` | **v0.7** — recover plugin cache after Claude Code `/plugin update` wipes it |
| `/ctx-version` | print installed ctx version |
| `/ctx-setup` | one-shot: install hooks + ensure config |
| `/ctx-install-hooks` | install just the hooks (idempotent) |
| `/ctx-uninstall-hooks` | remove ctx hooks; keep foreign hooks |
| `/ctx-daemon <start\|stop\|status\|log>` | background watcher for non-Claude-Code sessions |
| `/ctx-watch` | live token % monitor (blocks until Ctrl-C) |
| `/ctx-statusline` | preview one-line status for Claude Code statusline hook |

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
ctx metrics                  # pre_tool redirect compliance + cache stats
```

---

## `ctx metrics`

Reports whether Claude actually follows the `pre_tool_use` redirects you've configured. Reads `~/.config/ctx/hooks.log`, correlates each `deny`/`ask` event against the next tool call in the same session (within 60 seconds), and classifies the outcome.

```
ctx metrics
```

Sample output:

```
  ctx metrics — last 7 days

  pre_tool events: 160

  deny:
    total:        42
    obeyed:       31 (74%)
    bypassed:      8 (19%)
    abandoned:     3 ( 7%)

  top bypassed rules (needs attention):
    ^grep -r                         5 bypasses / 12 triggers  ( 42%)

  cache (last 7d):
    writes:   67
    reads:    41 (25 hits, 16 misses — 61% hit rate)
    gc sweeps: 4 (evicted 23 files, 78MB freed)
```

No flags in v0.7; default window is the last 7 days. Correlation needs `session_id` from Claude Code's hook payload — events without session_id are reported under a separate counter.

**Customized rules caveat:** if you've replaced the default `hooks.pre_tool_use.rules` array in your user config, the v0.7 additions (rg, grep -R, egrep, awk/sed, wc -l, find without -maxdepth) will NOT be merged automatically — arrays replace, not concatenate. Copy the new patterns from `config.default.json` manually.

### What the metrics actually measure

- **obey rate** = % of `deny` events where Claude switched to a `ctx_*` MCP tool within 60 seconds. High obey rate = the redirect culture is working. Low = either the reason message isn't landing or Claude is confident the command is fine.
- **bypass rate** = % of `deny` events where Claude ran the same Bash command anyway (exit=0). Each pattern's bypass rate is shown separately so you can see which rules Claude routinely ignores.
- **abandoned** = no follow-up tool call within 60s. Claude gave up on the intent, moved on, or asked the user.
- **cache hit rate** = `ctx_cache_get` hits / total reads. High rate means Claude is re-using summarized output instead of re-running heavy commands.

### Why this exists — expected savings

A single `grep -r` on a large codebase can emit 50–200 KB (12–50K tokens). `ctx_grep` caps the inline return at 5 KB (~1.2K tokens) plus a cache ref for the full content. **Per redirected call that's ~10–48K tokens saved.**

Cumulatively:
- **Typical session** (0–3 redirect-eligible commands): 0–15% context savings.
- **Heavy search session** (5–10 redirects): 15–40% savings.
- **Disaster avoided** (one `find /` that would've filled your context to 75%): a one-shot %30–50 window saved and no forced `/clear`.

The biggest wins are "context explosion prevented" moments — not measurable in percentages, measurable in sessions-not-abandoned. `ctx metrics` shows whether the redirect culture is actually sticking; tune the rules with data, not guesses.

### `ctx plugin-fix` — recovery for a Claude Code plugin-manager bug

Observed repeatedly: `/plugin update` or `autoUpdate` wipes `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>` but doesn't regenerate it. Every hook then emits `Plugin directory does not exist`. The marketplace checkout at `~/.claude/plugins/marketplaces/<marketplace>/` is still fine.

```bash
ctx plugin-fix      # terminal
# or
/ctx-plugin-fix     # slash (only works if the slash commands are already loaded)
```

The subcommand reads `installed_plugins.json`, finds ctx install paths that don't resolve, and restores them by `cp -R` from the stable marketplace checkout. Idempotent: "nothing to fix" when everything resolves. Tracked as an upstream bug; workaround until Anthropic patches it.

### Cache GC

`ctx_shell` / `ctx_read` / `ctx_grep` store full output in `~/.config/ctx/mcp-cache/` so Claude can paginate without re-running. v0.7 adds a GC layer:

- **TTL** 24h by default (`config.cache.gc.ttl_hours`)
- **max_bytes** 100 MB default (`config.cache.gc.max_bytes`), oldest-by-mtime evicted (LRU) when over
- **Probabilistic sweep**: `writeCache` triggers `sweep()` with 5% probability per write (`config.cache.gc.sweep_probability`). No separate daemon, no cron.
- Every `cache-write` / `cache-read result=<hit|miss>` / `cache-gc swept=N bytes_freed=M` event lands in `hooks.log` — `ctx metrics` rolls them up.

Disable GC with `config.cache.gc.enabled: false`.

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
