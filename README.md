# ctx

**A standalone CLI for knowing when to `/compact` or `/clear` your Claude Code session — and preparing the prompt that makes it worth it.**

Zero dependencies. Zero AI calls. Zero hooks inside your Claude Code session. You run it in a side terminal. It tells you what's happening, and hands you a prompt you can paste.

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
   > `/compact focus on API routes + DB/Schema — koru: files: petitions.ts, schema.prisma; 2 architecture decisions; failed attempts — devam: "now wire the stripe webhook"`
3. **Standalone.** No plugin, no hooks, no agent-sdk. Runs in a side terminal or as a background daemon. Your Claude Code session doesn't know it exists.
4. **Zero deps.** Pure Node built-ins. 1600 lines. Readable in one sitting.

---

## Install

```bash
git clone https://github.com/tugayoktayokay/ctx.git ~/tools/ctx
cd ~/tools/ctx
npm link
ctx --help
```

Requires Node 18+. No `npm install` step — the package has no dependencies.

---

## Commands

```bash
ctx                                  # analyze current session, show recommendation
ctx watch                            # live token % in foreground terminal
ctx daemon start|stop|status|log     # background watcher with macOS notifications
ctx compact                          # generate tailored /compact prompt, copy to clipboard
ctx snapshot [--name NAME]           # write session summary to your Claude Code memory dir
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

  Metrikler:
    Mesaj         : 75
    Tool kullanımı: 71
    Dosya değişim : 20
    Output toplamı: 183.7k token

  Analiz:
    • Context 54% of 200.0k quality ceiling (108.1k token)
    • Model limit: 1.0M, but quality düşüşü 200.0k'dan sonra başlar

  ✓ Özette tut:
    • aktif alanlar: Tests, Infra/DevOps, Bug fix, AI integration
    • değiştirilen dosyalar (20): …
    • son görev: "now wire the stripe webhook"

  ➜ ctx compact — tailored /compact promptu hazırlan
```

### `ctx compact` — tailored prompt

The payoff command. `ccusage` tells you 150k tokens are gone; `ctx compact` tells you *what* those tokens were and writes the prompt that preserves the important parts:

```
  /compact prompt (kopyala-yapıştır):

  /compact focus on API routes + DB/Schema + Bug fix — koru: dosyalar: petitions.ts, schema.prisma, petitions.test.ts, auth.ts; 2 mimari karar; başarısız denemeler; karar, endpoint, başarısız deneme — devam: "şimdi stripe webhook handler'ı ekleyelim petition için"

  ✓ Clipboard'a kopyalandı
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

- **Write to `CLAUDE.md`.** Your architecture docs are yours; `ctx` never touches them.
- **Install hooks into Claude Code.** No `SessionStart` / `PreToolUse` / `Stop` hooks. The tool has zero runtime cost inside your session.
- **Call an LLM.** Everything is regex, token math, and category heuristics. No `anthropic` SDK, no agent-sdk, no API key needed.
- **Auto-trigger `/clear` or `/compact`.** It generates the prompt; you decide when to run it.
- **Fire time-based alerts.** A 45-minute session that's at 30k tokens is fine. A 5-minute session that's at 180k is not.
- **Require an npm install.** No dependencies, ever.

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
  session.js      JSONL reader + findLatestSession
  analyzer.js     entries → stats (tokens + categories + files + decisions + critical patterns)
  decision.js     stats → level + action (model-aware thresholds)
  strategy.js     analysis → /compact prompt builder + clipboard
  snapshot.js     analysis → memory markdown + MEMORY.md index
  watcher.js      foreground live loop
  daemon.js       background loop + pid/log/state + git detection
  models.js       detectModel() + getLimits()
  config.js       defaults merge + user config loader
  output.js       ANSI formatting + macOS notifier
  cli.js          subcommand dispatch
bin/
  ctx             shebang entrypoint
```

Each module is independently testable. `src/test/*.test.js` mirrors this layout.

---

## License

MIT — see [LICENSE](LICENSE).
