# hooks_sample.log — expected aggregation

Assuming `now = 2026-04-21T10:15:00Z` and `range_days = 7`:

## Sessions
- S1: 4 deny (1 obeyed, 1 bypassed, 1 bypass_failed, 1 abandoned)
- S2: 3 ask (1 user_approved, 1 redirected, 1 canceled)
- S3: 4 deny (first with Read bystander → obeyed via ctx_grep; second → bypassed Bash; third of the consecutive pair → obeyed via ctx_grep; fourth of the consecutive pair → abandoned)

## Totals
- pre_tool.total = 11 (after excluding session=-)
- deny.total   = 8 (S1 ×4 + S3 ×4)
  - obeyed        = 3 (S1 first, S3 first-with-bystander, S3 third consecutive-first)
  - bypassed      = 2 (S1 second, S3 fourth)
  - bypass_failed = 1 (S1 third)
  - abandoned     = 2 (S1 fourth, S3 fourth-consecutive)
- ask.total    = 3 (S2)
  - user_approved = 1 (S2 first)
  - redirected    = 1 (S2 second)
  - canceled      = 1 (S2 third)

## Per-rule (top offenders)
- `^grep -r` triggers=5 (S1 once + S3 four), bypasses=1 (S3 second — grep -r baz) → 20%
- `^find /` triggers=1, bypasses=1 → 100%
- Others 0% bypass

## Cache
- writes = 1
- reads  = 2 (1 hit + 1 miss), hit_rate = 0.5
- gc_sweeps = 1

## Unscoped (session=-)
- 2 events (1 pre + 1 post)

## Parse errors
- 1 (the malformed line)
