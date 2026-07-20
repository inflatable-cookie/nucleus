# 198 Shared Project Files Controls

Status: completed
Owner: Tom
Updated: 2026-07-20
Milestone: `../041-shared-project-files-control.md`
Auto-start next card: yes

## Objective

Expose optional Shared project files configuration, sync policy, health, and
repair diagnostics behind project management controls.

## Acceptance

- [x] configuration is absent from basic New project and New chat flows
- [x] the UI distinguishes active server state from projected Git files
- [x] one active target is enforced truthfully
- [x] target health and policy come from the server read model rather than
  client path inspection or inference

## Validation

- desktop type checks and focused UI support tests
- generated control bindings match the Rust DTOs
- no Git or projection setup appears in basic creation flows

## Evidence

- Shared project files is available only from the project overflow menu
- configuration selects one attached Git resource and one closed sync policy
- ready, missing, moved, and repair-required health is server-derived
- detach confirms that active project state remains retained

## Stop Conditions

- project creation blocks on Git or forge configuration
- the UI implies every code repository receives management files
