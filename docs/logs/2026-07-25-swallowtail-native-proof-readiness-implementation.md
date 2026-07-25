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
- evidence opens the existing SQLite store query-only and emits terminal
  counts, never record content or identity

## Authority

The operator checkpointed the preceding sidebar lane at Nucleus
`7502b761e0a31fb8c3833d2777b068f3f8f998a9`. The clean Swallowtail source used
by the consumer is
`2959810f2da3cc64b28cf979094e0166a34c3ff8`.

The proof-readiness implementation remains a Nucleus working-tree change until
the operator reviews and checkpoints it. An unrelated uncommitted
`ProjectRail.svelte` rename refinement was preserved and excluded from this
batch.

## Evidence

- affected Rust packages compile, including test targets
- 2 cancellation-signal tests pass
- 1 typed terminal mapping test passes
- 2 exact-target registry tests pass across focused runs
- 1 query-only SQLite test passes
- 1 sanitized terminal-evidence fixture passes
- 3 desktop-profile tests pass
- 1 native cancellation panel guard passes
- `effigy desktop:check` passes with zero errors
- `effigy desktop:test` passes all 20 client tests
- missing and relative proof roots stop before desktop launch
- `git diff --check` passes

No Codex process, provider request, credential lookup, workspace write, push,
publication, or release mutation occurred.

## Remaining Gate

Card 010 needs an exact Nucleus checkpoint before it can freeze the live pilot
source. Installed Codex and catalogue probes remain read-only but separately
authorized by that handoff. The first provider request remains a later
operator gate.
