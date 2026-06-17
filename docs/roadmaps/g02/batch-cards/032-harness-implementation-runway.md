# 032 Harness Implementation Runway

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../009-harness-runtime-target-selection.md`

## Purpose

Compile the implementation runway for the selected first harness target.

This card closes target selection by producing the next executable milestone,
not by starting provider runtime code inside the selection milestone.

## Scope

- Update `../009-harness-runtime-target-selection.md` with the completed
  outcome.
- Compile the next harness implementation milestone in `g02`.
- Include ready gates for adapter registry records, session lifecycle records,
  runtime event ingestion, runtime receipts, approval/user-input handling,
  cancellation, recovery, and terminal fallback.
- Decide whether the next milestone starts with a fake/static adapter,
  protocol probe, or real provider process smoke path.
- Advance `docs/roadmaps/README.md` to the next bounded task.

## Acceptance Criteria

- The next milestone is ready to execute without new target-selection debate.
- The first implementation steps remain bounded and testable.
- Provider runtime side effects are gated behind command/effect authority.
- The roadmap still leaves `g02/010` client protocol work visible as the
  later transport lane.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if the target decision is still unsettled.
- Stop if implementation work would require UI or remote transport decisions
  from `g02/010`.

## Outcome

Compiled `../011-codex-app-server-runtime-runway.md` and ready cards
`033`-`036`.

The milestone starts with Codex app-server schema/probe evidence, registry
metadata, lifecycle identity, and static event ingestion fixtures. It does not
start live long-lived Codex execution.
