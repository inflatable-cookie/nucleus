A stuck host call or a long removal no longer starves the service's reads, and
every held slot is named with an owner, an age and a deadline.

- Every admitted Paseo effect has a deadline: sixty seconds, or thirty minutes
  for the effects that legitimately hold a slot while bulk work runs (a
  workspace archive, creation, recovery or closeout, and the observation
  inventory pass, whose individual pages keep the sixty-second bound). Past its
  deadline a call is abandoned as unknown: the caller hears that the outcome is
  unknown and that it was not resent, the class and total slots are freed, and
  recovery reads the recorded state. An abandoned effect that starts another
  request has it refused instead of sending it outside admission. The bound is
  per effect, so archive threads and settled-thread reconciliation in the cleanup
  class, and workspace recovery and closeout in the workspace class, are
  abandoned at the ordinary bound.
- `service.health.admission` names every held slot past five seconds with its
  class, holder, age and deadline, and the last abandoned call;
  `service.health.requestTimings.held` names the request holding the executor
  thread, with its age and how many requests are queued behind it. Both are
  read on the request loop, so they answer while the executor is blocked, and a
  wait for a slot is logged with the oldest holder and its age.
- Removing a populated checkout — a sibling worktree, an orphan checkout or an
  archived owned worktree — runs on libuv's pool instead of synchronously on the
  thread that serves reads. An archived orphan is renamed to a deterministic
  quarantine sibling first, so the walk removes exactly the tree the synchronous
  proof validated, and an interrupted walk is finished by the next pass instead
  of being reported as a completed archive.
