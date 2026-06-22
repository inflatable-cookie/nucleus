# 274 Provider Read-Intent Query DTO Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../073-provider-read-intent-serialized-control-envelope.md`

## Purpose

Add serialized request DTO vocabulary for provider read-intent projection.

## Acceptance Criteria

- [x] `ControlQueryDto` can encode provider read-intent projection.
- [x] DTO decode restores `ServerQueryKind::ProviderReadIntent`.
- [x] Unknown provider read-intent actions fail closed.
- [x] No provider effect authority is added.
