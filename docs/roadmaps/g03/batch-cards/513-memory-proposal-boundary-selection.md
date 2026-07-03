# 513 Memory Proposal Boundary Selection

Status: completed
Owner: Tom
Updated: 2026-07-03
Milestone: `../119-planning-memory-proposal-foundation.md`

## Purpose

Select the first bounded memory proposal slice.

## Work

- [x] Confirm the memory proposal boundary from contract `013`.
- [x] Identify which source refs belong in the first model.
- [x] Name deferred surfaces before code starts.
- [x] Update inventory if the boundary changes crate expectations.

## Acceptance Criteria

- [x] The selected boundary is narrow enough for a focused crate.
- [x] Proposed memory is distinct from accepted memory.
- [x] Secret, raw transcript, provider payload, and private-note storage are
  explicitly excluded.
- [x] No code behavior is added.

## Boundary Selection

The first implementation slice is a proposal-only domain crate:
`nucleus-memory`.

Included records:

- memory proposal ids
- proposal scopes
- proposal kinds
- proposal review statuses
- source refs
- confidence signal
- sensitivity class
- retention posture
- review state
- supersession refs
- promotion target refs

Initial source refs may point to:

- planning sessions
- exploration sessions
- planning artifacts
- task seeds
- research brief refs
- tasks
- agent sessions
- sanitized evidence refs
- provider-neutral SCM change refs
- documents
- custom refs

Excluded from this lane:

- accepted memory mutation
- embeddings
- vector storage
- semantic search
- autonomous extraction
- provider-native memory sync
- memory projection files
- final memory review UI
- raw transcripts
- provider payloads
- raw terminal streams
- credentials or secret values
- private notes by default

Acceptance in this lane means review evidence only. It does not create an
authoritative accepted memory store or project context mutation command.

## Evidence

- `docs/contracts/013-shared-memory-contract.md`
- `docs/roadmaps/g03/119-planning-memory-proposal-foundation.md`
- `docs/architecture/system-inventory.md`

## Stop Conditions

- The work requires choosing embeddings, vector storage, or semantic search.
- The work requires deciding autonomous extraction policy.
- The work requires final UI design.
