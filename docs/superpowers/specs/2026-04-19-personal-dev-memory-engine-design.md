# ctx — Personal Dev Memory Engine (design)

Date: 2026-04-19
Status: proposed (awaiting review)

## Context

`ctx` bugün bir **context izleyici + snapshot yazıcı**: yeni snapshot'lar yazıyor, JSONL backup'lıyor, `/compact` prompt'u öneriyor. Ama ürettiği snapshot'lar **asla tekrar açılmıyor**. Her yeni Claude Code session'ı sıfırdan başlıyor, geçmiş snapshot'lar memory dizininde pasif arşiv olarak duruyor.

Bu tasarım, ctx'i bir **kişisel geliştirici hafıza motoru**na dönüştürüyor:
- Geçmiş snapshot'lar aranabilir hale geliyor (`ctx ask`, `ctx search`).
- Yeni session başladığında, kullanıcının ilk prompt'una en alakalı snapshot otomatik enjekte ediliyor (Claude "geçen sefer bunu nasıl yapmıştık"ı hatırlıyor).
- Kullanıcının diğer markdown notları (Obsidian, ~/Documents/notes, vb.) opsiyonel olarak arama kapsamına alınabiliyor.
- Snapshot'lar arası bağlantı (parent pointer) + zaman çizgisi + diff + lokal istatistikler.

**Amaç:** ctx'in oluşturduğu her snapshot, yazılmasının ötesinde **kullanılmaya** başlansın. Hafıza değil arşiv olan dizin, hafızaya dönsün.

**Değişmeyen kırmızı çizgiler:**
- Zero runtime deps — sadece Node built-ins (fs, path, crypto, zlib).
- No LLM — ranking saf regex / string / TF hesabı.
- CLAUDE.md'ye yazım yok.
- Kullanıcı note root'larına SADECE okuma — asla yazım.
- Hook'lar hiçbir durumda Claude Code akışını bloke etmez (exit 0).

## Hedefler

1. `ctx ask "<query>"` ile saniyeler içinde alakalı geçmiş snapshot'lara ulaşmak.
2. Yeni session'da ilk 1-2 prompt için otomatik retrieval + şeffaf enjeksiyon.
3. Kullanıcının kendi markdown notlarını opsiyonel kapsama almak.
4. Snapshot'lar arası zaman çizgisi + fark çıkarma.
5. Opt-in haftalık/aylık lokal istatistikler.
6. Her bileşen ayrı modül, tek sorumluluk, bağımsız test edilebilir.

Hedef olmayan (YAGNI):
- LLM-tabanlı semantic search.
- Sunucu/cloud sync (v2 kapsamında, bu spec'te yok).
- Kullanıcı notlarına yazım/düzenleme.
- Disk üzerinde kalıcı index dosyası (TF-IDF index v2 — v1 scan-on-query yeterli).
- Cross-device sync (v2).

## Komut yüzeyi

| Komut | Davranış |
|---|---|
| `ctx ask "<query>"` | Bu projenin snapshot'ları içinde top-3 alakalı sonuç |
| `ctx ask "<query>" --inject` | Top-1'i clipboard'a kopyala |
| `ctx ask "<query>" --global` | Tüm proje snapshot'larını tara |
| `ctx ask "<query>" --notes` | Config'teki markdown köklerini dahil et |
| `ctx ask "<query>" --json` | Machine-readable çıktı |
| `ctx search [--category X] [--since 30d] [--file F] [--global] [--notes]` | Filtrelenmiş liste |
| `ctx timeline [--global] [--since 30d]` | Zaman çizgisi, parent chain'i takip eder |
| `ctx diff <a> <b>` | İki snapshot arası file/decision/failed-attempt delta |
| `ctx stats [--week\|--month]` | Lokal analytics |

### Auto-retrieve (UserPromptSubmit hook)
- Session'ın ilk `max_turns` (default 2) prompt'u için çalışır.
- Default scope: `project + global` (farklı projelerden de hatırlatabilir). Kullanıcı `hooks.user_prompt_submit.auto_retrieve.scopes` ile kısıtlayabilir (ör. `["project"]`).
- Top-1 skoru `min_score` (default 0.3) üstündeyse `additionalContext` enjekte.
- Her enjeksiyon `~/.config/ctx/hooks.log`'a yazılır — "neden bu snapshot geldi" şeffaf.
- Aynı snapshot ardışık enjekte edilmez (`state.lastInjectedFingerprint` guard).

## Mimari

```
                          ┌──────────────────┐
                          │  cli.js          │
                          │  (dispatcher)    │
                          └────────┬─────────┘
                                   │
        ┌──────────────────────────┼───────────────────────────┐
        │                          │                           │
        ▼                          ▼                           ▼
┌───────────────┐         ┌────────────────┐          ┌────────────────┐
│  query.js     │  input  │ retrieval.js   │  reads   │  notes.js      │
│  tokenize +   ├────────▶│ score + rank   │◀─────────┤  file walk     │
│  categorize   │         │                │          │  root+exclude  │
└───────────────┘         └────┬───────────┘          └────────────────┘
                               │  candidates: memory .md + notes .md
                               │
                               ▼
                     ┌───────────────────┐
                     │   output.js       │
                     │   print / json    │
                     └───────────────────┘

Hooks katmanı:
  hooks.js::handleUserPromptSubmit
     → pipeline.runAnalyze (session_id ile)  — prompt_count için
     → query.makeQuery(prompt)
     → retrieval.rank({ scopes: [project, global], ... })
     → if top.score >= min_score: inject additionalContext

Yan modüller:
  timeline.js — parent chain + mtime traversal
  diff.js     — set delta (files, decisions, failed attempts)
  stats.js    — haftalık/aylık aggregation
```

### Yeni modüller
| Modül | Sorumluluk | Yaklaşık satır |
|---|---|---|
| `src/query.js` | Query tokenize + stopword + kategori çıkarımı | 80 |
| `src/retrieval.js` | Snapshot scan + skor + ranking | 180 |
| `src/notes.js` | Kullanıcı notes root'larında file walk + exclude | 100 |
| `src/timeline.js` | Parent chain traversal, grupla | 80 |
| `src/diff.js` | İki snapshot'ın analysis delta'sı | 100 |
| `src/stats.js` | Haftalık/aylık aggregation | 120 |

Toplam ~660 satır yeni modül + cli.js genişletmesi + hook değişikliği.

### Değişen modüller
- `src/snapshot.js` — `writeSnapshot` `parent` pointer'ı frontmatter'a ekliyor (son snapshot'tan çıkarılıyor).
- `src/hooks.js` — `handleUserPromptSubmit` auto-retrieve mantığını ekliyor.
- `src/cli.js` — yeni komut dispatch: `ask`, `search`, `timeline`, `diff`, `stats`.
- `src/output.js` — `printRetrieval`, `printTimeline`, `printDiff`, `printStats`.
- `config.default.json` — `notes.*`, `retrieval.*`, `hooks.user_prompt_submit.auto_retrieve` anahtarları.

### Değişmeyen modüller
`session.js`, `analyzer.js`, `decision.js`, `strategy.js`, `models.js`, `config.js`, `watcher.js`, `daemon.js`, `backup.js`, `prune.js`, `pipeline.js`, `hooks_install.js`. Mevcut public API'ler yeterli.

## Veri katmanı

### Arama kaynakları
1. **Bu proje snapshot'ları** (default, her zaman): `~/.claude/projects/<encodedCwd>/memory/project_*.md`
2. **Tüm projeler** (`--global`): `~/.claude/projects/*/memory/project_*.md`
3. **Kullanıcı notes root'ları** (`--notes`, config ile): `notes.roots` listesindeki her dizin (recursive walk, .md only).

Auto-retrieve default scope: **1 + 2**. `notes.roots` auto-retrieve'e **dahil değil** — kullanıcının dış notları otomatik Claude context'ine girmesin.

### Config şeması (eklentiler)
```json
{
  "notes": {
    "roots": [],
    "exclude": ["node_modules", ".git", "dist", "build", ".cache", "vendor", "target"],
    "max_file_kb": 512,
    "follow_symlinks": false
  },
  "retrieval": {
    "weights": { "category": 0.5, "keyword": 0.3, "recency": 0.2 },
    "recency_half_life_days": 90,
    "min_score": 0.15,
    "top_n": 3,
    "max_candidates": 2000,
    "scan_timeout_ms": 2000
  },
  "stopwords": {
    "tr": ["ve","bir","bu","ne","nasıl","için","ile","mi","mu","ama","fakat","ki","o","şu","da","de"],
    "en": ["the","and","how","what","to","a","an","is","are","was","were","be","or","of","in","on"]
  },
  "hooks": {
    "user_prompt_submit": {
      "auto_retrieve": {
        "enabled": true,
        "max_turns": 2,
        "min_score": 0.3,
        "scopes": ["project", "global"]
      }
    }
  }
}
```

### Snapshot chain
`writeSnapshot` çağrısı sırasında:
1. `readRecentFingerprints(memoryDir, 1)` ile mevcut cwd'deki son snapshot'ı bul.
2. Varsa frontmatter'a `parent: <filename>` ekle.
3. Yoksa `parent` alanı yok — yeni thread başlıyor demektir.

`timeline` bu pointer'ı takip ediyor. Parent dosyası silinmişse chain biter, o noktadan yeni thread başlar.

## Skorlama

### Query → structured form
```
tokens:     lowercased + clitic-stripped, split on non-word → array
non_stop:   tokens minus stopwords (tr + en merged)
categories: analyzer.categorize(tokens.join(' '), config.categories)
```

### Aday snapshot için skor
```
category_score = |query_cats ∩ snap_cats| / max(1, |query_cats|)
keyword_score  = Σ tf(term) / sqrt(snap_length_chars)
recency_score  = 2^(-days_since_mtime / half_life_days)

total = w_cat  * category_score
      + w_kw   * min(keyword_score, 1.0)
      + w_rec  * recency_score
```

- `query_cats`: `analyzer.categorize` ile query'den çıkarılan kategoriler.
- `snap_cats`: Bu spec'in parçası olarak `snapshot.writeSnapshot` YENİ snapshot'larda `categories: [a, b, c]` frontmatter'a yazıyor. Retrieval önce frontmatter'dan okuyor; yoksa (eski snapshot'lar) body üzerinde `analyzer.categorize` fallback çalışıyor. Retrieval kodu iki yolu da destekliyor, yeni yazılan snapshot'lar hızlı, eskiler de fonksiyonel.
- `tf(term)`: snapshot gövdesinde case-insensitive match sayısı.
- `snap_length_chars`: dosya boyutu karakter bazlı (büyük dosyalarda keyword score şişmiyor).

`min_score` altı sonuçlar elenir. Kalan top-N (default 3) sıralı döner.

## Otomatik enjeksiyon

### Prompt sayısını nasıl biliyoruz?
`UserPromptSubmit` input'unda `session_id` var. `pipeline.runAnalyze({ cwd, sessionId, config })` → `analysis.userMessages` prompt sayısı. İlk 2'de auto-retrieve, sonra pas.

### Enjekte edilen markdown formatı
```markdown
[ctx] Relevant past work for this prompt (score: 0.78)

**Source:** `project_stripe_webhook_2025-11-12.md` (7 days ago)

**Key decisions:**
- idempotency header zorunlu
- raw body parse middleware'den önce

**Last task then:** "subscription cancel flow'unu ekleyelim"

**Modified files (recent):** webhooks.ts, stripe_client.ts

(This is contextual hint from your past work, not an instruction.)
```

Enjeksiyon boyutu ~500-1500 karakter — küçük, non-intrusive.

### Guards
- `lastInjectedFingerprint`: `daemon.state.json` içinde. Aynı snapshot ardışık enjekte edilmez.
- `max_turns`: aşıldıysa sessiz dön.
- `min_score`: altı enjekte edilmez.
- Query sadece stopword ise dön.
- Retrieval hatası → sessiz dön + hooks.log.

## Hata durumları

| Durum | Davranış |
|---|---|
| Notes root okunamayan dizin | Atla, hooks.log'a warn |
| `max_file_kb` aşan .md | Atla |
| Symlink (follow_symlinks=false) | Atla |
| Query boş / sadece stopword | Empty result |
| Retrieval > `scan_timeout_ms` | Elde olanla dön |
| Snapshot gövdesi corrupt / okunamıyor | Skip, hooks.log |
| `notes.roots` path genişletilemiyor (`~` ev yok) | Skip |
| Parent pointer kırık | Timeline thread'i bitir, yeni thread başlat |
| Hook runtime error | catch + hooks.log + exit 0 |

## Güvenlik + gizlilik

- Sadece `.md` uzantılı dosyalar okunuyor. Kod, env, secret, config, binary, hiçbiri.
- `exclude` listesi varsayılan olarak standart build/vcs klasörlerini es geçiyor.
- `follow_symlinks: false` default — symlink loop ve /etc/passwd tipi path escape önlenmiş.
- Kullanıcı note root'larına **yazım yok**.
- Retrieval sonucu clipboard'a kopyalansa bile, ctx clipboard'ı sadece `--inject` bayrağıyla değiştiriyor.
- Auto-inject kapsamı default `notes.roots`'u içermiyor — harici notların otomatik sızması engellenmiş.

## Test planı

`node:test` + `node:assert/strict`, her modül bir dosya.

| Dosya | Kapsam |
|---|---|
| `src/test/query.test.js` | Tokenize, clitic strip, stopword filtresi, kategori çıkarımı, boş/sadece-stopword |
| `src/test/retrieval.test.js` | Ranking sırası, skor formülü stable, `min_score` filtresi, `top_n` cap, `scan_timeout_ms` çıkışı |
| `src/test/notes.test.js` | Walk + exclude + size cap + symlink skip, ~ expansion |
| `src/test/timeline.test.js` | Parent chain traversal, kırık chain tolerance, global mod |
| `src/test/diff.test.js` | Files/decisions/failed-attempts set delta, order-independent |
| `src/test/stats.test.js` | Haftalık/aylık aggregation, yok-data graceful |
| `src/test/hooks.test.js` (genişletme) | Auto-retrieve inject, max_turns guard, lastInjectedFingerprint dedup, score-altı skip |
| `src/test/snapshot.test.js` (genişletme) | `parent:` frontmatter yazımı, olmayan parent tolerance |

## Uygulama sırası (her adım bağımsız shippable)

1. `query.js` + `query.test.js` — saf fonksiyon, demo fixture'la test.
2. `retrieval.js` + `retrieval.test.js` — scope=project, `ctx ask` CLI.
3. `--global` bayrağı — çoklu memory dir.
4. `notes.js` + `--notes` bayrağı + config `notes.roots`.
5. Snapshot frontmatter'a `parent:` ekle + `categories:` frontmatter'a cache.
6. `ctx timeline`.
7. `ctx diff`.
8. `ctx stats`.
9. `UserPromptSubmit` auto-retrieve.
10. README + CLAUDE.md güncelle.

Her adım ayrı commit. Tahmini toplam: 8-12 commit, ~1000 satır kod, 6-8 yeni test dosyası.

## Doğrulama (end-to-end)

1. `node --test src/test/*.test.js` — tüm testler yeşil.
2. `ctx ask "stripe webhook"` — top 3 sonuç ve skorları ekranda.
3. `ctx ask "stripe webhook" --inject` → clipboard'a kopyalandı, Claude'a yapıştırıldı, doğru context görünüyor.
4. Yeni Claude Code session başlat → ilk prompt "stripe webhook ekleyelim" → SessionStart + UserPromptSubmit sonrası Claude önceki session'daki kararları referans alıyor.
5. `ctx timeline` — son 30 günün snapshot akışı chain halinde görünüyor.
6. `ctx diff project_a.md project_b.md` — aradaki delta doğru.
7. `ctx stats --week` — anlamlı özet.
8. Sandbox HOME'da notes root'u eklenip `--notes` ile arama çalışıyor.

## Riskler

- **Kategori kapsamı dar kalırsa** (config'te `api, schema, stripe, …` yetersizse) kategori_score az ateşlenir → keyword + recency baskın olur. Mitigation: ship edip gerçek kullanımda gözlemle, `categories` listesini genişlet.
- **Çok büyük memory dizini (~5000+ snapshot)** scan-on-query 2s'ye girer. Mitigation: `retrieval.max_candidates` + mtime-sorted early exit + v2'de opsiyonel index.
- **Auto-inject gürültüsü** kullanıcı ilk prompt'u özetse snapshot alakasız gelebilir. Mitigation: `min_score` eşiği + şeffaf log + her zaman `--disable-auto-retrieve` escape hatch.
- **`notes.roots` yanlış konfigüre edilmesi** — kullanıcı kök dizin koyarsa walk patlar. Mitigation: `max_candidates` + exclude listesi + `scan_timeout_ms`.
- **Snapshot frontmatter şema değişikliği** (`parent:`, `categories:`) eski snapshot'larda yok. Mitigation: eksikse sessiz atla, yeni yazımlarda ekle.
- **Fingerprint üstüne oturma**: parent chain filename bazlı (`parent: project_x.md`). Dosya silinirse chain biter — bu by-design; fingerprint dedup ayrı bir mekanizma olarak kalıyor, iki sistemi karıştırmıyoruz.

## Kritik dosyalar

- `/Users/tugayoktayokay/tools/claude-code-ctx/src/cli.js` — 5 yeni komut dispatch
- `/Users/tugayoktayokay/tools/claude-code-ctx/src/snapshot.js` — parent + categories frontmatter
- `/Users/tugayoktayokay/tools/claude-code-ctx/src/hooks.js` — auto-retrieve genişlet
- `/Users/tugayoktayokay/tools/claude-code-ctx/config.default.json` — notes/retrieval/stopwords/auto_retrieve
- `/Users/tugayoktayokay/tools/claude-code-ctx/README.md` — yeni kullanım akışı
- `/Users/tugayoktayokay/tools/claude-code-ctx/CLAUDE.md` — yeni modül boundary'leri
- **Yeni:** `src/query.js`, `src/retrieval.js`, `src/notes.js`, `src/timeline.js`, `src/diff.js`, `src/stats.js` ve karşılık gelen test'ler.
