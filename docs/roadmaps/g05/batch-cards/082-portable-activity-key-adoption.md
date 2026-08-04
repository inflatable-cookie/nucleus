# 082 Portable Activity Key Adoption

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../005-observable-agent-chat-transcript.md`
Depends on: card 081
Auto-start next card: no

## Objective

Adopt Swallowtail's complete portable activity projection key without coupling
Nucleus persistence to provider-native identity.

## Acceptance

- [x] focused adoption ran with Swallowtail HEAD at `eeefe33496fa71ef9d80e5cb47cd1b514e08776b`
- [x] durable activity upserts use `ActivityObservation::key()`
- [x] Nucleus conversation, thread, canonical turn, and message identities remain separate
- [x] consumer-supplied runtime operation ids are not reused across retained projections
- [x] equal provider and activity ids under two operations retain two distinct rows
- [x] no provider-specific id parsing or rewriting is added

## Validation

- [x] focused adapter and chat-persistence fixtures pass
- [x] Rust check, docs QA, formatting, and diff checks pass

## Stop Conditions

- do not invent a Nucleus activity-key vocabulary
- do not migrate provider-native ids into Nucleus record identity
- do not broaden this change into transcript presentation or provider behavior

## Evidence

- Swallowtail HEAD was verified at
  `eeefe33496fa71ef9d80e5cb47cd1b514e08776b` for focused adoption. A concurrent
  sibling thread then committed a metadata-only Rust-floor change as `24bb767`.
  The current clean checkout remains a descendant of the requested activity-key
  commit; Nucleus did not move or reset it.
- `project_activity` reads the portable key once and persists its operation and
  activity components. The record id hashes those two components only; Nucleus
  conversation, canonical turn, and message ids remain payload linkage.
- Lifecycle updates under one key replace the retained row. A regression using
  the same provider and activity ids under two operations retains exactly two
  rows.
- Chat, task-execution, and diagnostic turns now share UUID-backed consumer
  runtime ids instead of a process-local sequence that resets on restart.
- Ten focused chat-persistence tests and 21 adapter tests pass. Two authenticated
  adapter cases remain intentionally ignored. Workspace Rust check passes.
