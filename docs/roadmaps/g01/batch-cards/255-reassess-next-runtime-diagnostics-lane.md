# 255 Reassess Next Runtime Diagnostics Lane

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Pick the next runtime diagnostics lane after the read-only panel is useful.

## Scope

- Review command evidence seed and panel validation.
- Identify missing server/runtime surfaces.
- Decide between artifact metadata detail, command event timeline, or runtime
  readiness diagnostics.

## Out Of Scope

- Implementing artifact payload retrieval.
- Implementing streaming output.
- Implementing write-enabled command controls.

## Promotion Targets

- `docs/roadmaps/g01`

## Acceptance Criteria

- The next lane is explicit.
- Deferred command/artifact/streaming controls remain documented.

## Outcome

The next lane is runtime readiness diagnostics query shape. Artifact payload
retrieval, streaming output, PTY, retry, cancellation, approval, and
write-enabled command controls remain deferred.
