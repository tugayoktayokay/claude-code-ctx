# ctx

**An integrated memory + backup agent for Claude Code. You code; ctx handles context hygiene — automatic snapshots, gzipped JSONL backups, tailored `/compact` prompts, auto-restore on new sessions.**

Zero dependencies. Zero AI calls. One command (`ctx setup`) installs the Claude Code hooks and the rest is automatic. Or run it standalone from a side terminal — your call.

---

## Why it exists

Claude Code now ships with Opus 4 at a 1M-token context window. But quality degrades well before you hit the ceiling — typically around 200k, where cache churn and attention dilution start to bite.

Existing tooling doesn't surface this:

| tool | problem it solves | what it misses |
|---|---|---|
| [ccusage](https://github.com/ryoppippi/ccusage) | "How much have I spent?" (cost + token reports) | No active in-session guidance |
| [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | "How much of my Pro/Max plan is left?" (5h windows) | Tracks plan quota, not context saturation |
| [claudikins-acm](https://github.com/elb-pr/claudikins-automatic-context-manager) | Auto-handoff at 60% via plugin hooks | Fixed threshold, no model-aware ceiling, plugin eats in-session tokens |
| [claude-mem](https://github.com/thedotmack/claude-mem) | AI-compressed memory injection via agent-sdk | Uses AI on every capture, SQLite + HTTP worker, heavy |
| **ctx** | **When should I stop? What should I preserve?** | — |

`ctx` answers two questions `ccusage` doesn't and makes two choices the plugins don't:

1. **Model-aware quality ceiling.** Opus 4's 1M is the technical max; 200k is where quality ceiling kicks in. `ctx` thresholds fire against the ceiling, not the max. Haiku gets 100k. Override per-model in config.
2. **Tailored `/compact` prompts.** `ctx compact` reads your session, detects categories (schema / api / auth / bug / etc.), extracts critical signals (decisions, failed attempts, endpoints, errors), and generates a ready-to-paste prompt like:
   > `/compact focus on API routes + DB/Schema — keep: files: petitions.ts, schema.prisma; 2 architectural decisions; failed attempts — continue: "now wire the stripe webhook"`
3. **Standalone.** No plugin, no hooks, no agent-sdk. Runs in a side terminal or as a background daemon. Your Claude Code session doesn't know it exists.
4. **Zero deps.** Pure Node built-ins. 1600 lines. Readable in one sitting.

---

## Install

```bash
npm install -g claude-code-ctx
ctx setup         # installs Claude Code hooks + ensures config file
ctx status        # verify everything is wired
```

`ctx setup` is idempotent. It reads your existing `~/.claude/settings.json`, makes a timestamped backup, and merges in ctx hooks tagged `source: "ctx"`. Your own hooks are never touched. Undo with `ctx uninstall-hooks`.

After setup, your Claude Code sessions get:

- **SessionStart** → last snapshot for this project is auto-injected as context. You never start from scratch after `/clear`.
- **Stop** → at `urgent`/`critical` level, a snapshot is written. At `critical`, the full JSONL is gzipped into `~/.config/ctx/backups/<project>/`.
- **PreCompact** → when you type `/compact`, ctx injects the tailored focus/keep/drop/continue as hint context so Claude's summarization knows what to preserve. (PreCompact doesn't rewrite the `/compact` command itself — Claude Code doesn't expose that — but the guidance lands in the same turn.)
- **PostToolUse** → every `git commit` triggers a snapshot with `trigger: commit` in the frontmatter.

Or from source:

```bash
git clone https://github.com/tugayoktayokay/claude-code-ctx.git ~/tools/claude-code-ctx
cd ~/tools/claude-code-ctx
npm link
ctx setup
```

Requires Node 18+. Nothing in `dependencies` or `devDependencies`.

> The CLI command is `ctx`. The npm package is `claude-code-ctx` because the bare `ctx` and `claude-ctx` names are taken or blocked by npm's typo-squatting policy.

---

## Commands

Integration:

```bash
ctx setup                            # install hooks + ensure config (run once)
ctx install-hooks                    # just the hook merge, idempotent
ctx uninstall-hooks                  # remove ctx hooks, preserve foreign ones
ctx status                           # health: hooks, daemon, last snapshot, backups
ctx hook <event>                     # internal stdin/stdout handler (Claude Code calls this)
```

Analysis + memory:

```bash
ctx                                  # analyze current session, show recommendation
ctx watch                            # live token % in foreground terminal
ctx daemon start|stop|status|log     # background watcher with macOS notifications
ctx compact                          # generate tailored /compact prompt, copy to clipboard
ctx snapshot [--name NAME]           # write session summary to your Claude Code memory dir
ctx ask "<query>" [--global] [--notes] [--inject] [--json]
                                     # search past snapshots, ranked by category + keyword + recency
ctx timeline                         # snapshot threads (follow parent chain)
ctx diff <snap-a> <snap-b>           # files/decisions/failed-attempts delta
ctx stats [--week|--month|--days N]  # local analytics
ctx prune [--apply] [--older-than 30d] [--keep-last 20] [--per-project]
                                     # dry-run memory cleanup; rerun with --apply to delete
ctx restore --list                   # show gzipped JSONL backups for this project
ctx restore <session-id> [--to P]    # gunzip a backup to stdout or a file
ctx history [N]                      # last N sessions across all projects
ctx config                           # open / create ~/.config/ctx/config.json
ctx file <path>                      # analyze a specific JSONL file
```

### `ctx` — analyze

Reads the most recent JSONL under `~/.claude/projects/<encoded-cwd>/` and prints:

```
  [█████████████████████░░░░░░░░░░░░░░░░░░░] 54%
  108.1k / 200.0k quality ceiling   (model max 1.0M)
  ⚠️  COMPACT
  model: claude-opus-4-7

  Metrics:
    Messages  : 75
    Tool calls: 71
    Files     : 20
    Output    : 183.7k tokens

  Analysis:
    • Context 54% of 200.0k quality ceiling (108.1k tokens)
    • Model max: 1.0M, but quality degrades past 200.0k

  ✓ Keep in compact:
    • active areas: Tests, Infra/DevOps, Bug fix, AI integration
    • modified files (20): …
    • last task: "now wire the stripe webhook"

  ➜ ctx compact — prepare a tailored /compact prompt
```

### `ctx compact` — tailored prompt

The payoff command. `ccusage` tells you 150k tokens are gone; `ctx compact` tells you *what* those tokens were and writes the prompt that preserves the important parts:

```
  /compact prompt (copy + paste):

  /compact focus on API routes + DB/Schema + Bug fix — keep: files: petitions.ts, schema.prisma, petitions.test.ts, auth.ts; 2 architectural decisions; failed attempts; decision, endpoint, failed attempt — continue: "now wire the stripe webhook"

  ✓ Copied to clipboard
```

Paste it straight into Claude Code. The structure tells Claude what to focus on, what to preserve, what to drop, and what you were about to do next.

### `ctx daemon` — background

```bash
ctx daemon start    # detaches, writes pid to ~/.config/ctx/daemon.pid
ctx daemon status   # uptime, last level, last git commit
ctx daemon log 30   # tail
ctx daemon stop
```

The daemon polls every 10 seconds (configurable). It fires a macOS notification when:
- You cross a threshold (`compact` / `urgent` / `critical`)
- You make a new git commit in the cwd — natural moment for `ctx snapshot`

No time-based alerts ("you've been coding for 45 minutes"). Token state or git state only.

### `ctx snapshot` — bridge to memory

Writes a markdown file into `~/.claude/projects/<cwd>/memory/project_<auto-name>.md` with:
- What files you modified
- Architectural decisions detected
- Failed approaches to avoid
- Last user intent
- Context metrics at snapshot time

Then appends a line to `MEMORY.md`. The next session's Claude Code instance loads it as context. If you use a custom `/snapshot` skill, this is the non-interactive version of it.

---

## Memory engine

Past snapshots are no longer a write-only archive. ctx ranks them by keyword + category + recency, and Claude Code's **UserPromptSubmit** hook auto-retrieves the most relevant one for your first 1-2 prompts of a new session — so you pick up where you left off instead of starting from zero.

**Explicit recall:**

```bash
ctx ask "stripe webhook"
# → top 3 snapshots with score breakdown (category/keyword/recency)

ctx ask "stripe webhook" --inject
# → copies top match to clipboard, paste into Claude

ctx ask "auth flow" --global
# → searches across all projects

ctx ask "design doc" --notes
# → also scans user markdown roots (~/notes, Obsidian vault, …)
#   configure via ~/.config/ctx/config.json → notes.roots
```

**Auto-inject:** on the first 1-2 prompts of a session, if a past snapshot scores ≥ `min_score` (default 0.3), ctx injects it as `additionalContext`. Every injection is logged to `~/.config/ctx/hooks.log` — fully transparent. Disable via `hooks.user_prompt_submit.auto_retrieve.enabled: false`.

**Timeline + diff:** `ctx timeline` threads snapshots by `parent:` pointer so you see a project's evolution. `ctx diff <a> <b>` shows what files/decisions/failed attempts changed between two snapshots.

**Stats:** `ctx stats --week` shows the last N days of snapshot counts, trigger sources (commit/urgent/manual), and top categories.

---

## Configuration

`~/.config/ctx/config.json` — created on first `ctx config` call.

```json
{
  "limits": {
    "models": {
      "claude-opus-4-7":   { "max": 1000000, "quality_ceiling": 200000 },
      "claude-sonnet-4-6": { "max": 200000,  "quality_ceiling": 200000 },
      "claude-haiku-4-5":  { "max": 200000,  "quality_ceiling": 100000 },
      "default":           { "max": 200000,  "quality_ceiling": 200000 }
    },
    "thresholds": {
      "comfortable": 0.20,
      "watch":       0.40,
      "compact":     0.55,
      "urgent":      0.75,
      "critical":    0.90
    }
  },
  "categories": {
    "api":    { "words": ["route", "endpoint", "fastify", "express"], "label": "API routes" },
    "schema": { "words": ["schema", "migration", "prisma"],          "label": "DB/Schema" }
  },
  "watch": {
    "interval_ms": 10000,
    "macos_notifications": true
  }
}
```

The model list is matched against Claude Code's `message.model` field in the JSONL. Unknown models fall back to `default`. The category word lists drive both detection and the `/compact` prompt structure.

---

## What ctx deliberately does *not* do

- **Write to `CLAUDE.md`.** Your architecture docs are yours; `ctx` never touches them. Snapshots go only into `~/.claude/projects/<cwd>/memory/`.
- **Auto-type `/clear`.** Slash commands are user actions; ctx doesn't pretend to be you. It *does* snapshot and back up the JSONL before you type `/clear`, so nothing is lost.
- **Call an LLM.** Everything is regex, token math, and category heuristics. No `anthropic` SDK, no agent-sdk, no API key needed.
- **Overwrite your own Claude Code hooks.** Install is tag-based (`source: "ctx"`). Uninstall removes only ctx-tagged entries. Foreign hooks, matchers, and command strings are preserved.
- **Fire time-based alerts.** A 45-minute session that's at 30k tokens is fine. A 5-minute session that's at 180k is not.
- **Require an npm install at runtime.** No dependencies, ever. You can drop the repo on a box with Node 18+ and `npm link`.

---

## Testing

```bash
node --test src/test/*.test.js
```

17 tests covering session parsing, analysis, decision thresholds, compact strategy, snapshot writing, model detection, and git integration. The fixture `src/test/fixtures/demo-session.jsonl` is the canonical reference for what a JSONL entry looks like.

---

## Architecture

```
src/
  session.js         JSONL reader, cwd encoding, findLatestSession
  analyzer.js        entries → stats (tokens + categories + files + decisions + critical patterns)
  decision.js        stats → level + action (model-aware thresholds)
  strategy.js        analysis → /compact prompt builder + clipboard
  pipeline.js        runAnalyze({cwd|sessionPath|entries, config}) — shared entry point
  snapshot.js        analysis → memory markdown + fingerprint dedup + MEMORY.md index/rewrite
  backup.js          stream JSONL → gzip + rotate + restore
  prune.js           planPrune/applyPrune memory dir, hand-written MEMORY.md lines preserved
  hooks.js           Claude Code hook handlers (stdin JSON → stdout JSON/empty, never blocks)
  hooks_install.js   merge/unmerge settings.json entries tagged source:"ctx"
  watcher.js         foreground live loop
  daemon.js          background loop + pid/log/state + optional auto-snapshot/backup
  models.js          detectModel() + getLimits()
  config.js          defaults merge + user config loader
  output.js          ANSI formatting + macOS notifier
  cli.js             subcommand dispatch
bin/
  ctx                shebang entrypoint (async-aware)
```

Each module is independently testable. `src/test/*.test.js` mirrors this layout. 53 tests total.

---

## License

MIT — see [LICENSE](LICENSE).
