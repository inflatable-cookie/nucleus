# 304 Codex Live Smoke Evidence Promotion

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../068-codex-live-executor-integration.md`

## Purpose

Promote the successful direct Codex smoke into fixture and contract evidence for
the durable executor lane.

## Scope

- Capture the protocol sequence: initialize, initialized, thread/start,
  turn/start, turn/completed, cleanup.
- Record the sanitized evidence fields that may enter durable state.
- Record the raw material fields that remain forbidden.
- Update the implementation gap index to distinguish smoke proof from durable
  executor integration.

## Acceptance Criteria

- [x] The live-smoke sequence is documented as implementation evidence.
- [x] Allowed executor evidence fields are named.
- [x] Forbidden raw material fields are named.
- [x] The next persistence card has enough shape to implement without another
      planning pause.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`

## Stop Conditions

- Stop if the evidence would require storing raw provider material.
