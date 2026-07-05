# 557 Accepted Memory Storage Shape

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../127-accepted-memory-authority-proof.md`

## Purpose

Add accepted-memory domain/storage types without changing proposal semantics.

## Work

- [x] Add accepted-memory ids, records, status, payload/body, source refs,
  sensitivity, confidence, retention, actor, review, and supersession storage
  shapes.
- [x] Keep proposal records separate from accepted-memory records.
- [x] Add codec tests that reject raw transcript/provider/terminal/secret
  vocabulary in fixtures.
- [x] Keep embeddings, search, projection, provider sync, and UI out of scope.

## Acceptance Criteria

- [x] Accepted-memory records round-trip as sanitized storage payloads.
- [x] Proposal records remain proposal-side evidence.
- [x] No accepted-memory mutation command is added yet.

## Result

Added accepted-memory vocabulary to `nucleus-memory`:

- stable `MemoryId`
- `AcceptedMemory` domain record
- accepted-memory status/body/actor/review/timestamp types
- accepted-memory JSON storage record and codec
- accepted-memory supersession refs

Proposal ids remain evidence refs. Proposal records are unchanged and remain
proposal-side.

Focused tests prove:

- accepted memory is authoritative server context but not projection authority
- accepted-memory storage round-trips as sanitized JSON
- encoded fixtures exclude raw transcript, provider payload, terminal stream,
  credential, secret value, and private-note vocabulary
- storage records do not grant mutation, projection, search, provider sync, or
  UI effects
