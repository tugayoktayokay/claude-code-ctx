# ctx — Claude Code context manager

Zero-dep Node CLI that reads Claude Code JSONL transcripts, tracks context/token budget live, generates tailored `/compact` prompts, and dumps session state into your memory dir for `/snapshot` continuity.

Not a hook, not a daemon — run it in its own terminal.

## Install

```bash
cd ~/tools/ctx
npm link
ctx --help
```

## Commands

```bash
ctx                              # aktif session özet + öneri
ctx watch                        # canlı token % monitor (foreground)
ctx daemon start|stop|status|log # arka plan izleme + git commit notif
ctx compact                      # /compact prompt üret + clipboard
ctx snapshot [--name NAME]       # memory'e session özeti yaz
ctx history [N]                  # son N session metrikleri
ctx config                       # config dosyasını aç / oluştur
ctx file <path>                  # belirli JSONL'i analiz et
```

## Daemon

Arka planda sessizce çalışır. Eşik geçişlerinde ve yeni git commit'lerde macOS notification atar.

```bash
ctx daemon start    # detach eder, pid ~/.config/ctx/daemon.pid
ctx daemon status   # uptime, son seviye, son commit
ctx daemon log 30   # son 30 satır log
ctx daemon stop     # SIGTERM + pid dosyasını temizle
```

Commit sonrası bildirim geldiğinde: `/snapshot` + `/clear` için doğal an.

## Config

`~/.config/ctx/config.json` — ilk `ctx config` çağrısında default'larla oluşur.

Key idea: **quality ceiling**. Opus 4.7 1M context'e çıkabilir ama 200k'dan sonra kalite düşer. Eşikler `max` değil `quality_ceiling` üzerinden hesaplanır — "teknik sığar ama akıllı değil" uyarısı.

Override in config:

```json
{
  "limits": {
    "models": {
      "claude-opus-4-7": { "max": 1000000, "quality_ceiling": 200000 }
    },
    "thresholds": {
      "comfortable": 0.20,
      "watch":       0.40,
      "compact":     0.55,
      "urgent":      0.75,
      "critical":    0.90
    }
  }
}
```

## Tests

```bash
node --test src/test/*.test.js
```

## Yapmadıkları (explicit)

- CLAUDE.md'ye yazmaz
- Hook kurmaz
- npm dependency kullanmaz
- AI çağırmaz, sadece matematik + regex
- Otomatik `/clear` veya `/compact` tetiklemez (sen yaparsın)
