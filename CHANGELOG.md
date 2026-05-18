# Changelog

All notable changes to claude-code-ctx are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [v0.8.11] — 2026-05-18

### Fixed
- **Cache reuse metric had the wrong denominator.** Every Bash post_tool hook auto-cached its output regardless of size — so the `cache writes` count was ~10x inflated by entries Claude never saw a ref for. The reported `cache reuse rate: 1%` was actually closer to ~20% on the recallable subset.
- `cache-write` log lines now carry a `source=mcp|post_tool` tag:
  - `source=mcp` — written by `ctx_shell` / `ctx_read` / `ctx_grep` when output exceeded the inline limit. Claude received a "Recall via: ctx_cache_get(...)" hint.
  - `source=post_tool` — written by the Bash post-tool hook, no hint surfaced. Excluded from the reuse rate calculation.
  - Pre-0.8.11 entries lack the tag; they become `unknown_writes` and are also excluded. They age out of the 7-day window naturally.
- `ctx savings` and `ctx metrics` now report `<N> recallable writes` (and break down auto/unknown counts separately) so the rate matches the surface Claude can actually see.

### Added
- New `aggregateCache` fields: `hint_writes`, `auto_writes`, `unknown_writes`.
- Regression test asserting source-aware splitting and that auto-writes do not dilute the utilization rate.

## [v0.8.10] — 2026-05-18

### Fixed
- **Cache-write hints were not callable MCP syntax.** `ctx_shell` / `ctx_read` / `ctx_grep` previously emitted `ref: abc123  (ctx_cache_get ref="abc123" offset=0 to read chunks)` — which Claude would have to translate into a JSON tool call by hand. With 338+ cache writes and only 3 read hits (last 7d), the hint was the bottleneck. Now emits a directly callable line: `Recall full content: ctx_cache_get({ref: "abc123", offset: 0, limit: 4000})`.
- `ctx_cache_get` description rewritten to be unambiguous about when and how to call it (includes an inline example).

## [v0.8.9] — 2026-05-18

### Fixed
- **ctx_grep alternation silently returned 0 matches** on machines without `rg`. The grep fallback used plain `-rn`, which treats `|` literally — so patterns like `TODO|FIXME|XXX`, `console.(log|error)`, or `as any|as never` were always reported as "no matches" even when the targets existed. Discovered while tracing FitCrate session: 5 consecutive ctx_grep calls returned 48 bytes (empty marker). Fallback now uses `grep -rEn` so extended regex (alternation, grouping) works as users expect.
- **`recursiveGrepExample` mis-identified pattern when grep had value-taking flags** (`-m N`, `-A N`, `-B N`, `--include=...`). Example: `grep -rn -m 100 "TODO|FIXME" /tmp` produced a deny example of `ctx_grep({pattern: "100", path: "TODO|FIXME"})`. Now flag/value pairs are skipped via an explicit `GREP_VALUE_FLAGS` set.
- **Metric obey detection mis-classified rational fallbacks as abandoned.** When Claude denied on `grep -r feedback` and read `services/feedback.ts` directly within seconds, the metric called it "abandoned." That is obey behavior, not abandonment. Added `OBEY_ALT_TOOLS` (Read/Edit/Write/MultiEdit/Glob) within a 30-second window; these now count as `obeyed` for deny and `redirected` for ask. Bash-matching-pattern still classifies as `bypassed`; unrelated Bash is still a bystander.

## [v0.8.8] — 2026-05-18

### Added
- `ctx working-set` — active git changes, files, recent commands, last test/error, and largest current-session outputs.
- `ctx repomap` — compact repository file/symbol map inspired by Codex Ctx.
- `ctx savings` — rough token savings estimate from cache hits plus working-memory dedup hits.
- `ctx doctor` now warns when the installed Claude Code plugin version differs from the source checkout version.

## [v0.8.7] — 2026-05-18

### Added
- `doctor.drift` config block — runtime drift thresholds (`deny_min_total`, `deny_obey_threshold`, `ask_min_total`, `ask_cancel_threshold`, `cache_min_writes`, `range_days`) are now user-tunable instead of hard-coded.
- `splitShellArgs` keeps `$(...)` and backticks as opaque tokens so dynamic `ctx_grep` examples survive subshell-bearing commands.
- `src/test/fixtures/regression_bash_commands.json` — 100-command regression corpus generated from real `hooks.log` sessions.
- `CHANGELOG.md` — first release notes file. Status headers added to all 7 plan documents under `docs/superpowers/plans/`.

### Fixed
- Tighter test coverage: `splitShellArgs` + `recursiveGrepExample` now have direct unit tests; `checkRuntimeDrift` honours config overrides under test.

## [v0.8.6] — 2026-05-18

### Added
- `ctx doctor` `checkRuntimeDrift` — warns when `working_memory` is enabled but emits zero events, when deny obey rate < 50%, when ask cancel rate > 50%, or when cache writes exist without any read hits.
- Per-rule cancel/abandon counters in `ctx metrics`; `top canceled rules` + `top abandoned rules` surfaces.
- Deny messages now include a concrete `ctx_grep` / `ctx_shell` / `ctx_read` example tool call parsed from the offending command, plus an explicit "do not abandon" instruction targeting the high-abandon-rate signal.
- Reachability test now covers `PostToolUse` matchers in addition to `PreToolUse`.

## [v0.8.5] — 2026-05-18

### Added
- `src/test/real_commands.test.js` + `fixtures/real_bash_commands.json` — curated 12-case corpus of real production commands (FitCrate session) asserting expected pre-tool decisions.

## [v0.8.4] — 2026-05-18

### Added
- `src/test/manifest_reachability.test.js` — fails if `hooks.js` references a `tool_name === 'X'` branch that `.claude-plugin/plugin.json` does not route via a `PreToolUse` matcher. Closes the "code implemented, manifest forgot" silent-bug class.

## [v0.8.3] — 2026-05-18

### Fixed
- `.claude-plugin/plugin.json` PreToolUse now has both `Bash` and `Read` matchers. Previously, the Read working-memory dedup branch in `hooks.js` (shipped in v0.7.x as Phase 1) was never invoked in production because the plugin manifest only routed `Bash`. Silent dead code for ~3 weeks; surfaced after FitCrate `ctx heavy` showed 173k tokens dominated by Read/Edit output.

## [v0.8.2] — 2026-05-16

### Fixed
- Recursive grep deny pattern consolidated and broadened. Now matches:
  - Combined flags: `grep -rn`, `grep -rln`, `grep -nrE`
  - cd-chain prefixes: `cd /path && grep -rn ...`
  - Pipe prefixes: `ls | grep -r foo`
  - `egrep`, `grep --recursive`
- Previously, only `^grep -r` was caught — variants slipped through and dumped full recursive output into context (caught in production via FitCrate hooks log).

## [v0.8.1] — 2026-05-16

### Changed
- Default context output volumes reduced (`limit_bytes` defaults trimmed across `ctx_read` / `ctx_shell` / `ctx_grep`).

## [v0.8.0] — 2026-05-04

### Added
- **Working memory Phase 2** — Bash dedup. Time-windowed allowlist for read-only (`grep`, `find`, `ls`, `cat`, `head`, `tail`, `wc`) and state-probe (`git log`/`status`/`diff`, `npm ls`, `kubectl get`, `docker ps`) commands. Mutating commands always pass through. Gated by `working_memory.bash_dedup.enabled` (default `false`).
- `working_memory.bash_dedup_hits` + `bytes_saved` metrics surfaced via `ctx metrics`.

## [v0.7.x] — 2026-04

Highlights across the 0.7 line:
- **Working memory Phase 1** — Read dedup with hash + recency-window gating (v0.7.x-rc / v0.8.0-rc.1).
- **Edit-pressure-aware proactive `/compact`** (v0.7.7).
- **Metrics + GC coverage** for measurement-driven iteration (v0.7.5).
- **Install-path visibility** in `ctx --version` to disambiguate plugin vs. CLI install (v0.7.4).
- **BM25 persistent cache** for snapshot search (v0.7.x).

Earlier releases are documented in commit history.

[Unreleased]: https://github.com/tugayoktayokay/claude-code-ctx/compare/v0.8.11...HEAD
[v0.8.11]: https://github.com/tugayoktayokay/claude-code-ctx/compare/v0.8.10...v0.8.11
[v0.8.10]: https://github.com/tugayoktayokay/claude-code-ctx/compare/v0.8.9...v0.8.10
[v0.8.9]: https://github.com/tugayoktayokay/claude-code-ctx/compare/v0.8.8...v0.8.9
[v0.8.7]: https://github.com/tugayoktayokay/claude-code-ctx/compare/v0.8.6...v0.8.7
[v0.8.6]: https://github.com/tugayoktayokay/claude-code-ctx/compare/v0.8.5...v0.8.6
[v0.8.5]: https://github.com/tugayoktayokay/claude-code-ctx/compare/v0.8.4...v0.8.5
[v0.8.4]: https://github.com/tugayoktayokay/claude-code-ctx/compare/v0.8.3...v0.8.4
[v0.8.3]: https://github.com/tugayoktayokay/claude-code-ctx/compare/v0.8.2...v0.8.3
[v0.8.2]: https://github.com/tugayoktayokay/claude-code-ctx/compare/v0.8.1...v0.8.2
[v0.8.1]: https://github.com/tugayoktayokay/claude-code-ctx/compare/v0.8.0...v0.8.1
[v0.8.0]: https://github.com/tugayoktayokay/claude-code-ctx/compare/v0.7.9...v0.8.0
