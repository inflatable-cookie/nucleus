# 572 Accepted Memory Projection File Materialization

Status: completed
Owner: Tom
Updated: 2026-07-05
Milestone: `../130-accepted-memory-projection-file-materialization.md`

## Purpose

Write admitted accepted-memory projection payloads to scoped project
management files.

## Work

- [x] Add a scoped writer that accepts admitted write intents and projected
  payloads.
- [x] Restrict writes to `nucleus/memory/<memory-id>.toml` under the project
  management root.
- [x] Report materialized, skipped, blocked, unsafe-path, and encode-failed
  outcomes.
- [x] Preserve no-effect flags for SCM/forge, import/apply, embeddings/search,
  provider sync, task mutation, and UI behavior.

## Acceptance Criteria

- [x] Tests prove writes stay under the admitted projection root.
- [x] Tests prove blocked or unsafe records are skipped and reported.
- [x] Tests prove the writer does not call SCM/forge providers.
- [x] The writer is small and isolated from query/DTO/CLI rendering modules.

## Result

Accepted-memory projection materialization now has a scoped writer for
admitted payloads. It writes only under `nucleus/memory/` beneath the supplied
project management root.

Blocked admissions, unsafe refs, and payload/admission mismatches are skipped
and counted. The materializer reports file-write effects separately while
keeping SCM/forge, import/apply, embeddings/search, provider sync, task
mutation, and UI effects false.
