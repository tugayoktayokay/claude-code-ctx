# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node --test src/test/*.test.js         # run full test suite
node --test src/test/decision.test.js  # run one test file
./bin/ctx --help                       # run the CLI locally (no build step)
npm link                               # symlink `ctx` globally from this checkout
```

There is no build, bundle, or lint step — the package ships the raw `src/` tree and runs directly on Node 18+.

## Hard invariants (do not violate)

These are load-bearing promises of the project, not style preferences:

- **Zero runtime dependencies.** `package.json` has no `dependencies` or `devDependencies`. Use only Node built-ins (`fs`, `path`, `os`, `child_process`, `zlib`, `crypto`, `node:test`, `node:assert`). Do not add packages.
- **No LLM calls.** Every inference (categories, decisions, critical signals, names) is regex / string / arithmetic. Do not import `@anthropic-ai/*` or any model SDK.
- **Never write to the user's `CLAUDE.md`** or any project-level documentation. Snapshot output goes only into `~/.claude/projects/<cwd>/memory/`.
- **Never auto-type `/clear`.** Auto-snapshot before `/clear` and auto-restore after are fine, but the user always types the slash command.
- **Alerts are state-driven, not time-driven.** Notifications fire on threshold crossings, new git commits, or Stop hook events — never on "N minutes elapsed".
- **Hooks must degrade silently.** On any error, hook handlers log to `~/.config/ctx/hooks.log` and return exit 0. A broken hook never blocks the user's Claude Code session.

## Architecture

Data flows one direction through pure-ish modules; `cli.js` is the only orchestrator. Daemon + CLI + hooks all go through `pipeline.runAnalyze` — it is the single entry point from "I have a cwd" to "I have analysis/decision/strategy".

```
bin/ctx → src/cli.js
           │
           ├── session.js       read ~/.claude/projects/<encoded-cwd>/*.jsonl → entries[]
           ├── analyzer.js      entries → stats (tokens, files, categories, decisions, failed attempts)
           ├── models.js        detectModel(entries) + getLimits(modelId, config)
           ├── decision.js      stats + limits → { level, action, reasons, metrics }
           ├── strategy.js      analysis + decision → { keep, drop, compactPrompt }
           ├── pipeline.js      runAnalyze({cwd|sessionPath|sessionId|entries, config})
           ├── snapshot.js      markdown + frontmatter (parent, categories, fingerprint, trigger)
           ├── query.js         query → {tokens, nonStop, categories}        ← memory engine
           ├── retrieval.js     collect + score + rank snapshots              ← memory engine
           ├── notes.js         user markdown roots walk (.md only, exclude)  ← memory engine
           ├── timeline.js      parent-chain traversal, thread grouping       ← memory engine
           ├── diff.js          snapshot facts delta (files/decisions/failed) ← memory engine
           ├── stats.js         trigger + category aggregation                ← memory engine
           ├── backup.js        stream gzip JSONL + rotate + restore
           ├── prune.js         memory dir planPrune/applyPrune
           ├── hooks.js         Claude Code hook handlers (incl. auto-retrieve)
           ├── hooks_install.js merge/unmerge ctx entries in settings.json (source: "ctx" tag)
           ├── watcher.js       foreground live loop
           ├── daemon.js        background loop + optional auto-snapshot/backup
           ├── output.js        ANSI formatting + osascript notifier
           └── config.js        config.default.json ← deepMerge ← ~/.config/ctx/config.json
```

Key boundaries:

- **`session.js` owns filesystem layout.** `encodeCwd()` turns `/Users/x/proj` into `-Users-x-proj` (matches Claude Code's own encoding). Nothing else should compute that path — `backup.js` and `snapshot.js` reuse it.
- **`analyzer.js` is the single source of truth for what a session "is".** Token counting takes the max of `input + cache_read + cache_creation` across entries (not the sum) — the last turn already includes cache. Do not change this without updating tests.
- **`decision.js` thresholds fire against `quality_ceiling`, not `max`.** Opus 4.7's `max` is 1M but its ceiling is 200k. This distinction is the whole point of the tool.
- **`strategy.js` generates the `/compact` prompt.** Shape: `/compact focus on <top-3-categories> — keep: <files/decisions/signals> — drop: <noise> — continue: "<last user intent>"`. Tests pin this format.
- **`snapshot.js` writes to the user's Claude Code memory dir** (`~/.claude/projects/<encoded-cwd>/memory/`). Each file gets frontmatter (`name`/`description`/`type`/`trigger`/`fingerprint`). Dedup reads `fingerprint:` from the last 3 snapshots — same fingerprint = skip write. Hand-written MEMORY.md lines are preserved by `rewriteIndex`.
- **`hooks.js` is stateless, non-blocking, and silent.** Handlers read JSON stdin, write JSON/empty stdout, log errors to `~/.config/ctx/hooks.log`, and always exit 0. `pipeline.runAnalyze` and `snapshot.writeSnapshot` are reached via `require('./pipeline.js').runAnalyze` (not destructured) so tests can swap them.
- **`hooks_install.js` tags every entry it writes with `source: "ctx"` and `ctxSchemaVersion: 1`.** Uninstall matches on that tag, never on command string — a user who renames their binary keeps working.
- **`daemon.js` state lives in `~/.config/ctx/`**: `daemon.pid`, `daemon.log`, `daemon.state.json`. Notifications are deduped by a 10-minute window in `state.notifiedAt`. Auto-snapshot/auto-backup are off by default (`daemon.auto_snapshot_on: []`) because hooks cover the primary path; daemon is the safety net for sessions outside Claude Code. The `__run__` subcommand is the detached child entrypoint — not a public command.
- **`backup.js` streams gzip (never reads whole JSONL into memory).** Rotation is per-cwd by `keep_last`. Restore paths are prefix-matched; ambiguity throws rather than picking arbitrarily.
- **Memory engine modules (`query.js`, `retrieval.js`, `notes.js`, `timeline.js`, `diff.js`, `stats.js`) are pure functions with zero external state.** They read from disk and return plain data. Never write, never call hooks, never touch the daemon. This makes them trivially testable and safe to compose.
- **`retrieval.readSnapshotHead` is the only canonical frontmatter parser.** If you need to read a snapshot's metadata from another module (timeline, stats, diff), import this function — don't re-implement parsing.
- **Auto-retrieval respects user privacy boundaries:** default scopes are `["project", "global"]` — memory dirs only. `notes.roots` are never auto-injected; they require an explicit `--notes` flag on `ctx ask`.

## Config

`config.default.json` (shipped) is deep-merged with `~/.config/ctx/config.json` (user). Arrays are replaced, not concatenated — adding a word to `categories.api.words` in the user file replaces the whole list. Keep `config.default.json` authoritative; `config.js::loadDefaults` reads it at runtime, so changes take effect without a rebuild.

Model IDs go through `normalizeModelId()` which strips the `anthropic/` prefix, date suffixes (`-20260101`), and bracket suffixes (`[1m]`). If you add a new model family, add it to both `config.default.json` and the tests.

## Testing conventions

- Tests use `node:test` + `node:assert/strict`, one file per module, mirroring `src/`.
- `src/test/fixtures/demo-session.jsonl` is the canonical JSONL shape. When changing entry parsing, update the fixture rather than mocking.
- `analyzer.test.js` asserts floor values (`>= 95000`, `>= 5`) not exact counts — keep it that way so small fixture edits don't cascade.
- `strategy.test.js` pins the `/compact` prompt format. If you change the prompt shape, that's a deliberate product decision — update the test in the same commit.

## Things that look like bugs but aren't

- `analyzer.js::CRITICAL_PATTERNS` contains Turkish regexes (`karar`, `çalışmadı`, `olmadı`) alongside English ones. This is intentional bilingual detection — the author codes in both languages. Don't "clean it up".
- `strategy.js::copyToClipboard` silently returns `false` on non-darwin. The CLI reports "clipboard: not copied" rather than failing. Keep that behavior.
- `session.js::findLatestSession` falls back to scanning *all* of `~/.claude/projects/` when the project-specific dir is missing. This is intentional so `ctx` works from subdirectories Claude Code hasn't indexed yet.
