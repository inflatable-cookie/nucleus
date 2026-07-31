# 007 Structured Provider Work

Status: completed
Owner: Tom
Created: 2026-07-31

## Purpose

Preserve and present Swallowtail's portable plan, task-list, actor, and child
topology structure instead of flattening it into generic tool-call rows.

## Governing Refs

- `../../contracts/019-conversation-timeline-contract.md`
- `../../contracts/024-harness-mediation-tool-projection-contract.md`
- `../../contracts/030-swallowtail-agent-runtime-integration-contract.md`
- `../../../swallowtail/docs/contracts/044-observable-agent-activity-and-disclosure.md`
- `../../../swallowtail/docs/contracts/045-subagent-topology-observation-and-control.md`
- `../../../swallowtail/docs/guides/observable-activity.md`
- `../../../poodle/docs/contracts/components/agent-transcript.md`

## Generation Runway Goal

Expose useful provider work structure while keeping Nucleus Tasks and control
authority separate.

## Goals

- [x] persist portable actor, task-list, and subagent snapshots
- [x] preserve checklist item status, priority, order, replacement, and clear
- [x] maintain one operation-local `SubagentDirectoryProjection`
- [x] attribute and navigate main, child, and unknown work honestly
- [x] render structured plans and checklists without creating Nucleus Tasks

## Execution Plan

### Batch 7.1 — Lossless Durable Projection

- [x] Execute card 022.
- [x] Extend storage and DTOs with the exact portable structure.
- [x] Prove snapshot replacement, omission, clear, and unknown preservation.

### Batch 7.2 — Structured Transcript

- [x] Execute card 023.
- [x] Present plan and task-list structure with current Poodle primitives.
- [x] Keep provider checklist rows distinct from durable product Tasks.

### Batch 7.3 — Child Directory And Navigation

- [x] Execute card 024.
- [x] Fold snapshots into one directory per operation.
- [x] Add durable child selection and attributed transcript filtering without
      control actions.

## Acceptance Criteria

- [x] task-list status and priority survive restart
- [x] omission does not clear and an empty snapshot does
- [x] child first-seen order and unknown fields survive restart
- [x] operation termination invents no child terminal state
- [x] no direct child-control affordance appears
