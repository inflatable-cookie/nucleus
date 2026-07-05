# 558 Memory Proposal Acceptance Admission

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../127-accepted-memory-authority-proof.md`

## Purpose

Model promotion admission from reviewed memory proposals to accepted memory
records.

## Work

- [x] Require reviewed-for-promotion proposal state.
- [x] Require explicit operator/reviewer refs and sanitized source evidence
  refs.
- [x] Block rejected, deferred, archived, stale, user-private, restricted, and
  secret-adjacent proposals unless policy explicitly allows them.
- [x] Emit blocked/admitted admission records without writing accepted memory.

## Acceptance Criteria

- [x] Admission is inspectable without mutation.
- [x] Sensitivity and retention policy fail closed.
- [x] No projection, embedding, search, provider sync, task, SCM/forge, or UI
  effect is added.

## Result

Added pure proposal-to-accepted-memory admission in `nucleus-memory`.

Admission requires:

- proposal status `review_requested`
- review status `reviewed_for_promotion`
- command admission id, memory id, proposal id, created-by ref, accepted-by ref
- proposal reviewer ref
- sanitized evidence refs from command, source refs, or link refs

Admission blocks:

- non-reviewed proposals
- rejected, stale, superseded, and archived proposals
- deferred reviews
- user-private, restricted, and secret-adjacent proposals in this lane
- empty title or summary
- proposal id mismatch
- missing operator/reviewer/evidence refs

Admitted results prepare an `AcceptedMemoryStorageRecord` but do not write it.
No shared-memory persistence, projection, embedding, provider sync, automatic
extraction, task mutation, SCM/forge mutation, or UI effect is performed.
