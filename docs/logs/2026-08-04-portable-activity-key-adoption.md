# Portable Activity Key Adoption

Date: 2026-08-04
Roadmap: `../roadmaps/g05/005-observable-agent-chat-transcript.md`
Card: `../roadmaps/g05/batch-cards/082-portable-activity-key-adoption.md`
Validated Swallowtail commit: `eeefe33496fa71ef9d80e5cb47cd1b514e08776b`

## Changed

- Nucleus reads `ActivityObservation::key()` at the durable projection boundary.
- Activity record identity hashes the portable runtime operation and
  operation-local activity id. Repeated lifecycle observations replace one
  retained row.
- Nucleus conversation, provider-thread, canonical turn, and transcript-message
  ids remain separate payload linkage.
- Chat, task, and diagnostic runtime turns use UUID-backed consumer ids so a
  process restart does not reset the activity operation namespace.
- Provider activity references remain opaque and are not parsed or rewritten.

## Regression Evidence

One deterministic fixture supplies the same provider activity reference and
the same activity id to two runtime operations. Start and completion under the
first key upsert one row. The second operation retains another row. History
contains exactly two rows, ordered by their latest runtime event sequences.

## Validation

- 10 focused local chat-persistence tests pass.
- 21 adapter tests pass; two authenticated Codex cases remain ignored.
- `effigy check:rust` passes.
- Docs QA, Northstar QA, Rust formatting, and diff checks pass.

## External Worktree State

Swallowtail HEAD was the requested commit during focused adoption. A separate
thread then committed a root `rust-version` change from 1.93 to 1.90 as
`24bb767`. The current clean checkout is a descendant of the requested commit
and retains `ActivityKey`. Nucleus did not modify or reset the sibling checkout.

## Next

Select the next bounded g05 product priority.
