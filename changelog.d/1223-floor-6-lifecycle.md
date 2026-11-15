- Retry routing, the queued wait projection, agent asks, external merge, closeout, hook replay and the
  owned workspace archive each have one owner per mechanism: retry decisions are typed and separate from
  the recorded evidence they read, an ask's lifecycle is decoded once instead of per event prefix, an
  observed external merge is recorded by one function, the stale closeout base rule is shared with its
  per-merge bound, a hook refusal's kind is typed where it is recorded, and the archive takes a typed
  request and reports a typed teardown refusal. The dead `repository-archive-gate.ts` is gone.
