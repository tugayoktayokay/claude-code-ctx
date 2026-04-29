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
- **Working memory is per-session and ephemeral.** Stored under `~/.config/ctx/working_memory/<sid>.{json,blobs/...}`. Hash-gated — files that changed always get a fresh Read. Disable via `working_memory.enabled = false` (default).

## Architecture

One-way data flow; `cli.js` dispatches, `pipeline.runAnalyze` is the single entry to the analysis/decision/strategy bundle. Module map: `session → analyzer → decision/strategy/snapshot` (core), plus orthogonal modules for `backup`, `prune`, `hooks`/`hooks_install`, memory engine (`query`, `retrieval`, `notes`, `timeline`, `diff`, `stats`), `watcher`/`daemon`, `output`, `config`. One file = one responsibility; run `ls src/` for the current list.

Non-obvious boundaries that matter for changes:

- **`session.encodeCwd`** is the only encoder for `~/.claude/projects/<cwd>/` path. `backup.js` and `snapshot.js` reuse it — don't invent new ones.
- **`analyzer.js` token counting** takes the `max` of `input + cache_read + cache_creation` across entries (not the sum; last turn already contains cache). Don't change without updating tests.
- **`decision.js` thresholds fire against `quality_ceiling`, not `max`.** Opus 4.7 max=1M, ceiling=200k. This distinction is the whole point.
- **`strategy.js::compactPrompt` shape is pinned by tests:** `/compact focus on <cats> — keep: <...> — drop: <...> — continue: "<intent>"`.
- **`snapshot.js` frontmatter contract:** `name`/`trigger`/`fingerprint`/`categories`/`parent`. Dedup reads fingerprint from last 3 snapshots. Hand-written MEMORY.md lines are preserved by `rewriteIndex` (line matches `^- \[project_...\](...)`).
- **`hooks.js` is stateless + non-blocking:** always exit 0, log errors to `~/.config/ctx/hooks.log`. Internal modules are reached via `pipeline.runAnalyze(...)` not destructured — tests need to swap them.
- **`hooks_install.js` tags with `source: "ctx"`** and matches on that tag for uninstall. Foreign user hooks are preserved. Install command path comes from `resolveCtxCommand()` (process.argv[1]) — survives nvm/custom PATH.
- **`backup.js` uses copyFileSync → gzip → atomic rename** (not live stream copy) so an actively-appended JSONL doesn't produce a truncated backup.
- **Memory engine modules (`query`/`retrieval`/`notes`/`timeline`/`diff`/`stats`/`optimize`)** are pure: read disk, return plain data. `retrieval.readSnapshotHead` is the only canonical frontmatter parser — reuse it.
- **`notes.roots` never auto-injects.** Auto-retrieval scope defaults `["project", "global"]` — memory dirs only. `--notes` is explicit-opt-in via `ctx ask`.
- **`daemon.js` auto-snapshot/backup default off** (`auto_snapshot_on: []`). Hooks cover the primary path; daemon is the fallback for sessions outside Claude Code.

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
