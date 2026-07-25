# Swallowtail Native Proof Readiness Implementation

Date: 2026-07-25

## Outcome

Nucleus can now prepare Swallowtail's application-scale proof through the
normal native Agent Chat path without touching normal user state or making a
provider call.

The deterministic batch completes g05 cards 007-009:

- one process-start desktop profile owns database, task-review snapshot, and
  UI-config paths
- the normal `~/.nucleus` paths and 180-second deadline remain defaults
- an explicit proof root and shorter bounded deadline fail closed on invalid
  input
- active-turn cancellation is project-and-conversation scoped outside the
  serialized chat mutex
- the adapter wakes, requests Swallowtail turn cancellation, joins cleanup,
  and retains typed cancelled, timed-out, cleanup-failed, and other failures
- persisted turns distinguish completed, cancelled, timed-out, and failed
- Effigy exposes `desktop:proof` and `desktop:proof:evidence`
- the proof selector requires a disposable Git fixture and binds fresh seeded
  state to it instead of the Nucleus source tree
- evidence opens the existing SQLite store query-only and emits terminal
  counts, never record content or identity

## Authority

The operator checkpointed the preceding sidebar lane at Nucleus
`7502b761e0a31fb8c3833d2777b068f3f8f998a9`. The clean Swallowtail source used
by the consumer is
`2959810f2da3cc64b28cf979094e0166a34c3ff8`.

The proof-readiness implementation was checkpointed at
`d4d8b2b3511b5f2ea40c4cfc684a295a3754008f`. Disposable fixture binding then
completed at `2a6d72a8d3326cc70c6852f8fa86ff7f8ca995f2`. An unrelated uncommitted
`ProjectRail.svelte` refinement remains preserved outside the batch.

## Evidence

- affected Rust packages compile, including test targets
- 2 cancellation-signal tests pass
- 1 typed terminal mapping test passes
- 2 exact-target registry tests pass across focused runs
- 1 query-only SQLite test passes
- 1 sanitized terminal-evidence fixture passes
- 4 desktop-profile tests pass
- explicit fixture binding resolves editor reads against the disposable root
- 1 native cancellation panel guard passes
- `effigy desktop:check` passes with zero errors
- `effigy desktop:test` passes all 20 client tests
- missing and relative proof roots stop before desktop launch
- `git diff --check` passes

No Codex process, provider request, credential lookup, workspace write, push,
publication, or release mutation occurred.

## Remaining Gate

Card 010 now freezes the exact live pilot. The first authenticated catalogue
request and every model turn remain behind explicit operator approval.
