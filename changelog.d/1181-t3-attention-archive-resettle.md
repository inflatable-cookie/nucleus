# 1181: surface stuck T3 worker threads, archive superseded workers, resettle retained reviewers

- A T3 task that enters `blocked`, `error`, `needs_attention` or an attention
  escalation unsettles its worker thread, so the stuck task shows in T3's main
  list; returning to work or review settles it again through the ordinary rules.
- `route now` to a different profile (and approval or failover reroutes)
  archives the old worker thread at once, once its run is released and no live
  T3 run remains — a durable, idempotent, observation-first archive and the one
  mid-task archive the open-task rule allows.
- A retained reviewer continued for a second round is settled again after that
  round: the adapter tracks which thread it settled, and an unsettle since earns
  a fresh settle command instead of early-returning on the old receipt. A settle
  bind the Nightly rejects as stale retires and the current latest run is settled
  under a fresh command; compatibility failures keep their exact field in the
  settlement warning and retry on the next pass.
