# Heavy-Bash → ctx_shell redirect (phase 1)

**Date:** 2026-04-20
**Target version:** 0.6.0
**Scope:** Configuration + MCP tool descriptions + structured deny/ask logging. No new MCP tools, no runtime behavior changes beyond the existing `pre_tool_use` rule engine.

## Context

Biggest real token sink observed on v0.5.0 is not retrieval — it's Claude running raw Bash for heavy traversals (`find /`, `grep -r`, `docker logs`, etc.) and getting 100KB+ output back. Each such event can be 25k+ tokens. Current `pre_tool_use` rules catch *some* of these with `default_mode: 'ask'`, but:

- Reasons point at Claude's built-in `Grep` tool, not at our MCP `ctx_shell` / `ctx_grep` / `ctx_read` wrappers that cache + summarize.
- Coverage is incomplete (`du`, `head/tail -n N`, `docker logs`, `kubectl logs`, `ps -ef` not matched).
- Per-rule `mode` override does not exist; every rule inherits `default_mode`.
- No structured log of deny/ask decisions, so we can't measure whether redirection works in practice (phase 2 needs this data).

This is a **phase 1** change: tighten what we already have, record data, defer the aggressive `default_mode: 'deny'` decision to phase 2 once we can measure.

## Decision

1. Update `config.default.json` rules: rewrite reason strings to recommend `ctx_shell` by name; add a per-rule `mode` field; extend the pattern set.
2. Update `ctx_shell` / `ctx_read` / `ctx_grep` descriptions in `src/mcp_tools.js` to be more actionable — threshold, examples, and explicit "use instead of raw Bash" framing.
3. Add structured decision logging to `handlePreToolUse` in `src/hooks.js`. Append one line per deny/ask to `~/.config/ctx/hooks.log` with a parseable format phase 2 can analyze.

No new runtime dependencies. No change to hook handler signatures. No change to public MCP or CLI interfaces.

## Architecture

### Rule schema change (backward compatible)

Existing rule objects in `config.default.json`:

```json
{ "tool": "Bash", "match": "...", "reason": "..." }
```

New optional field:

```json
{ "tool": "Bash", "match": "...", "mode": "deny", "reason": "..." }
```

Reading code in `src/hooks.js::handlePreToolUse` already resolves mode as:

```js
const mode = rule.mode || pre.default_mode || 'ask';
```

so `rule.mode` is honored if present; rules without it keep current behavior. No loader change needed.

### Rule inventory (after change)

**`mode: "deny"`** — unambiguously heavy, always wrong:

| Pattern (regex) | Reason |
|---|---|
| `^\s*find\s+[/~]` | Unbounded filesystem traversal. Use `ctx_shell({command: "find / ..."})` — returns summary + ref. |
| `^\s*grep\s+-r(\s\|$)` | Recursive grep. Use `ctx_grep({pattern, path})` — returns inline if small, summary+ref if big. Matches all `grep -r`; `ctx_grep` is a safe drop-in. |
| `^\s*cat\s+/var/log/` | Log files flood context. Use `ctx_read({path, limit_bytes: 5000})` or `tail -n 200`. |
| `^\s*du\s+-a` | `du -a` lists every file. Use `du -sh <path>` or `ctx_shell` if you really need it. |

**`mode: "ask"`** — sometimes legitimate, let user decide:

| Pattern | Reason |
|---|---|
| `^\s*ls\s+-R(\s|$)` | Recursive `ls` usually floods. Narrow the path or use `ctx_shell` for summary. |
| `^\s*tree(\s+[/~]\|\s*$)` | Unbounded tree. Add `-L <depth>` or use `ctx_shell`. |
| `^\s*(journalctl\|dmesg)(\s\|$)(?!.*-n)` | System logs need `-n`. Try `journalctl -n 200` or `ctx_shell`. |
| `^\s*(npm\|pnpm\|yarn)\s+ls(\s\|$)(?!.*--depth)` | Dep tree needs `--depth`. Try `--depth=0`. |
| `^\s*git\s+log(\s\|$)(?!.*-n\b)(?!.*--oneline)` | Full `git log` is huge. Add `-n 20` or `--oneline`. |
| `^\s*history(\s\|$)(?!.*\|)` | `history` dumps everything. Pipe through `tail -50` or `grep`. |
| `^\s*docker\s+logs(\s\|$)(?!.*--tail)` | Container logs need `--tail N`. |
| `^\s*kubectl\s+logs(\s\|$)(?!.*--tail)` | Same — use `--tail N`. |
| `^\s*ps\s+-ef(\s\|$)` | Full process list is noisy. Filter with `pgrep` or `ps -ef \| grep`. |
| `^\s*head\s+-n\s+\d{4,}` | `head -n` with 4+ digit count. Use `ctx_read` with `limit_bytes`. |
| `^\s*tail\s+-n\s+\d{4,}` | Same for `tail`. |

All reason strings that reference an MCP tool use the exact name (`ctx_shell`, `ctx_grep`, `ctx_read`) so Claude can look it up unambiguously.

### MCP tool description rewrites

Three tools, same template:

**`ctx_shell`**

> Run a shell command and return a short summary if output exceeds `limit_bytes` (default 5000). Full output is cached to disk and retrievable via `ctx_cache_get({ref, offset, limit})`. **Use this instead of raw Bash for any command likely to produce >5KB** — examples: `find`, `grep -r`, `ls -R`, `tree`, `journalctl`, `docker logs`, `du -a`, large `git log`. Raw Bash returns the full output into context; this tool returns ~500 bytes of summary instead.

**`ctx_read`**

> Read a file and return it directly if under `limit_bytes` (default 5000), otherwise summarize head/tail and cache the full body for paged retrieval. Use instead of raw `cat`/`Read` for files >5KB, especially logs and generated output.

**`ctx_grep`**

> Run `grep` with a pattern and path, returning matches directly if under `limit_bytes` (default 5000), otherwise summary + ref. Use instead of raw `grep -r` for codebase searches — output is truncated safely.

### Structured decision log

`src/hooks.js::handlePreToolUse` currently calls:

```js
logHook(config, `pre-tool-use ${action} tool=${toolName} rule="${rule.match}" reason="${reason}"`);
```

Change the format to a **parseable single-line key-value** block so phase 2 can grep/parse without a real log library:

```
<ISO8601> pre_tool action=deny|ask|allow tool=Bash pattern="<regex>" cmd_head="<first 40 chars of command>" reason="<reason>"
```

Key changes:
- Event tag `pre_tool` (stable identifier).
- `pattern` retained.
- New `cmd_head` — first 40 chars of the command. Embedded `"` → `\"`, embedded newline → space. Needed for phase 2 to correlate with subsequent MCP tool calls.
- Existing `reason` stays.

No changes to other log lines (session-start, stop, post-tool-use, auto-retrieve). Their formats remain free-form strings; future phases can migrate as needed.

### File touch list

| File | Change | LOC estimate |
|---|---|---|
| `config.default.json` | Replace `hooks.pre_tool_use.rules` with the 15-rule list above (4 deny + 11 ask). | ~40 |
| `src/mcp_tools.js` | Update `description` field on `ctx_shell`, `ctx_read`, `ctx_grep`. No handler changes. | ~6 |
| `src/hooks.js` | Rewrite the `logHook(...)` call in `handlePreToolUse` to the structured format. | ~6 |
| `src/test/hooks.test.js` | One new test: `pre_tool_use honors rule.mode override`. Existing tests shouldn't need edits. | ~15 |
| `src/test/mcp_tools.test.js` | No assertion on description text today; no update needed. (Verify during execution.) | 0 |
| `README.md` | One line under the features list mentioning the expanded rule set. | 1 |

## Testing

Two new / updated tests:

1. **`hooks.test.js` — rule.mode override**: feed a synthetic config where one rule has `mode: 'deny'` and `default_mode: 'ask'`. Send a matching Bash input. Assert the hook output's `permissionDecision` is `deny`.

2. **`hooks.test.js` — structured log format**: redirect `HOME` to temp dir, run `handlePreToolUse` with a matching rule, read `~/.config/ctx/hooks.log`, assert it matches `/pre_tool action=(deny|ask|allow) tool=\S+ pattern=".*" cmd_head=".*" reason=".*"/`.

Existing tests that touch pre_tool_use must continue to pass. The regression risk is the regex set — any existing test that calls a pattern expecting `ask` must still get `ask` (i.e. all currently-covered patterns that stay in the list must stay at their current mode).

**Before finalizing:** check `src/test/hooks.test.js` for tests that call commands matching `find`, `grep -r`, `cat /var/log/`, or `du` — these move from `ask` (inherited from `default_mode`) to `deny`. Those tests need their assertion updated, or the test command adjusted to match a different (still-ask) pattern.

## Non-goals

- **Not** changing global `default_mode`. It stays `ask`.
- **Not** introducing auto-redirection (hooks can't rewrite tool calls; deny + reason is the mechanism).
- **Not** adding new MCP tools. `ctx_shell`/`ctx_read`/`ctx_grep` exist; we make them more discoverable.
- **Not** measuring phase 2 correlation in this phase. The log format makes it possible; actual analysis happens after data accumulates.

## Risks

| Risk | Mitigation |
|---|---|
| Existing `hooks.test.js` assertions break because a pattern that was `ask` is now `deny` | Enumerate affected tests during implementation (grep the test file for each pattern); update assertions in the same commit. |
| Users have a custom `~/.config/ctx/config.json` that overrides `rules` — our new rules don't reach them | Documented as expected: user overrides win. Phase 2 can add a migration nudge in `ctx doctor` if adoption matters. |
| A `deny` reason mentions `ctx_shell` but the MCP server isn't running for that user | Fallback: reason strings always include an inline alternative (`find -maxdepth`, `tail -n 200`, etc.) so Claude can follow either path. |
| Log format change breaks any downstream parsing | No known downstream parsers exist for `hooks.log`. The log is internal diagnostic output; free to change. |
| Regex false positives on legitimate narrow commands (e.g. `find src/ -name foo`) | All `find` patterns start with `/` or `~`; narrow `find src/` is not matched. Manually audit each pattern against 3-5 realistic call sites during implementation. |

## Open questions

None.
