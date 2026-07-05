# 556 Accepted Memory Authority Boundary

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../127-accepted-memory-authority-proof.md`

## Purpose

Select the smallest accepted-memory authority boundary before changing
`nucleus-memory` types.

## Work

- [x] Define which reviewed proposal states can be promoted.
- [x] Define accepted-memory ids, scopes, kinds, status, body, source refs,
  confidence, sensitivity, retention, review, actor, and supersession fields.
- [x] Define blocked effects and forbidden payload classes.
- [x] Decide whether batch `557` should proceed or the lane needs a contract
  update first.

## Acceptance Criteria

- [x] The boundary can be implemented without embeddings, semantic search,
  provider-native memory sync, automatic extraction, projection files, final UI,
  SCM/forge mutation, or raw transcript retention.
- [x] User-private, restricted, secret-adjacent, and shared project memory
  policy is explicit.
- [x] The next implementation card has clear stop/go criteria.

## Decision

Batch `557` should proceed. The existing shared-memory contract is sufficient
for a narrow storage-shape proof.

Promotable proposal state:

- proposal status: `review_requested`
- review status: `reviewed_for_promotion`
- reviewer/operator ref present
- sanitized source or evidence refs present

Accepted-memory records are separate from proposal records. A proposal remains
review evidence; it does not become the durable memory id.

Accepted-memory storage fields:

- stable memory id
- source proposal id
- scope
- kind
- status
- title
- sanitized body
- source refs
- link refs
- confidence
- sensitivity
- retention
- created actor/ref
- accepted actor/ref
- created/accepted/updated timestamps where known
- review note ref or sanitized note
- supersession refs

First storage statuses:

- `accepted`
- `stale`
- `superseded`
- `archived`

Proposal statuses remain proposal-side. Rejected proposals do not become
accepted-memory records.

Sensitivity policy:

- `public_project` and `internal_project` can become shared project memory
  when reviewed
- `user_private` remains server-local
- `secret_adjacent` can store sanitized summary refs only and must not store
  secret values
- `restricted` is blocked from shared-memory promotion in this lane

Blocked effects:

- embeddings
- semantic search or ranking
- provider-native memory sync
- autonomous extraction
- projection files
- final UI behavior
- task mutation
- SCM/forge mutation
- raw transcript, provider payload, terminal stream, credential, secret value,
  and private-note retention

Stop `557` if accepted-memory storage cannot be added without changing
proposal records or introducing mutation commands.
