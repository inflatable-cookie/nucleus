Qualification foundation, tranche 3 (Spec 064 P5–P7): a host proof attempt now has
one cumulative clock, a charged storage ledger, typed observation/ack/settlement
evidence, spent retention, and a refusal that names every external input it still
needs.

- **One cumulative clock.** `firstEffectClock` is established before the dispatch
  funnel — reservation persistence included — and rides the private plan and the
  run intent, so the supervisor, the endpoint and the settlement read the same
  origin. A retry continues the earliest recorded origin instead of restarting the
  600 s target, an effect ordered before the origin refuses, and hitting the target
  is permanent.
- **The storage ledger.** Entries charge the spec's inventory — the database file
  with its WAL and journal (each whole where one run's share is unproven),
  publications, the combined log including framing, every permitted copy and
  retained failure — with provider, owner, writers, method, sample tick, missing
  coverage and reserve safety. The entries are disjoint by construction: a shared
  parent excludes the subtrees another entry charges, so the combined sum counts
  every byte once. The 512 MiB target and the 22 GiB reserve safety are monitored;
  a breach latches the first fault and requests the direct-command stop, and an
  unknown charge is never read as fit. The ledger is logical sampling and claims
  no all-physical peak.
- **Typed evidence, one writer each.** The supervisor alone writes the
  observation (subject, clock, its own direct-child wait, the parent waits it
  holds, real per-stream terminals, the artifact's exact evidence, the ledger, and
  `not_applicable: unbuffered` for its flush). The endpoint alone writes the ack
  (observation digest plus the artifact's length, hash, per-stream lengths, hashes
  and EOF/DRAIN sequences, inside the target) and the settlement, which records
  each independent gate and the separate target/workload/evidence/resources/closure
  outcomes with no inferred `closed` flag. A passing gate never satisfies another.
- **Exact acceptance.** A qualification-mode result is accepted only against the
  recorded settlement digest, through the executor's existing authentication, and
  it references the one raw artifact rather than a proof-files copy.
- **Spent retention and loss.** Losing the service→S parent, or a roll during a
  proof, spends the attempt as unknown/SPENT/retained even if the supervisor later
  writes a result; restart only reconciles. Retention keeps the raw bytes, the
  sidecars and the charged residuals while anything is unresolved — and an attempt
  that already carries a recorded retention failure keeps that row too, because
  nothing about it is resolved. The ordinary expiry marker is no deletion
  authority for any of it.
- **A bounded EOF wait.** The strict capture's wait for a pipe's real EOF is
  bounded by the attempt's own first-effect deadline, so it can only spend what is
  left of the target; when it expires the stream stays `unknown` and the step
  settles, with no manufactured EOF, no group or escapee signal and no extra
  cleanup time.
- **Refuse before effects.** Real qualification proof mode refuses before any
  effect until Effigy's prepare custody and genuine admission, a common elapsed
  clock, every creator's own wait, the joined DECIDING census and the separate
  FINAL census, image-attachment provider evidence, the capture/delivery
  conjunction and the accounting/readiness measurement are all present and
  qualified. Today none are supplied, so the mode refuses and names each missing
  input; authentication alone starts nothing.

Qualification mode stays opt-in and dormant: with it absent, every host-run, QA and
proof-execution behaviour is unchanged — the two capped streams, the redaction, the
group stop and the ordinary records. No native run, image, VM, resource probe or
hold release happened.
