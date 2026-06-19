# 283 Codex Turn Start Reactor Dry Run

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../063-provider-command-reactor-gate.md`

## Purpose

Route Codex turn-start envelopes through provider command reactor records
without sending to Codex.

## Scope

- Use existing turn-start request, admission, and envelope records.
- Add dry-run reactor admission/queue/dispatch/outcome linkage.
- Record why live send remains disabled.
- Do not write to Codex stdio.

## Acceptance Criteria

- Turn-start can enter reactor records after envelope creation.
- Dry-run outcome maps to receipt/event vocabulary.
- Live provider send remains blocked by an explicit gate.

## Validation

- [x] targeted Codex/server tests
- [x] `cargo check --workspace`
- [x] `git diff --check`

## Stop Conditions

- Stop if turn-start reactor routing exposes missing provider identity rules.

## Result

Added a Codex turn-start reactor dry-run bridge that consumes an accepted
turn-start envelope and produces provider command admission, queue, dispatch,
and outcome records without writing to Codex stdio.

The dry-run outcome maps to the existing provider runtime receipt/event
vocabulary and records that live provider send remains disabled until the
provider command reactor gate closes.
