# 013 Cross-Panel Operation Catalogue

Status: completed
Owner: Tom
Created: 2026-08-01

## Purpose

Expose bounded cross-panel progress and cancellation for host work without
replacing Nucleus Tasks, transcripts, or runtime receipts.

## Governing Refs

- `../../contracts/018-orchestration-contract.md`
- `../../contracts/020-runtime-receipt-contract.md`
- `../../contracts/032-longhorn-desktop-systems-integration-contract.md`
- `../../../../longhorn/docs/contracts/015-async-operation-lifecycle.md`

## Generation Runway Goal

Let work remain understandable when its initiating panel is no longer active.

## Goals

- [x] define exact mappings from eligible Nucleus work to Longhorn operations
- [x] preserve product detail and durable evidence in Nucleus
- [x] expose active/recent work with truthful cancellation and terminal state
- [x] bound retention and teardown

## Execution Plan

### Authority Mapping

- [x] start with Forge, resource, indexing, and recovery-shaped fixtures
- [x] exclude provider questions, plans, Tasks, and transcript detail

### Renderer Projection

- [x] add one isolated Svelte session and compact Poodle presentation
- [x] keep cancellation requests distinct from confirmed cancellation

### Operation Acceptance

- [x] prove races, retry lineage, remount, project switch, and shutdown
- [x] verify no duplicate durable authority

## Acceptance Criteria

- [x] active work remains visible outside its originating panel
- [x] terminal state is sticky and late progress cannot reopen work
- [x] cancellation receipts do not fabricate stopped execution
- [x] renderer teardown does not cancel host work
- [x] Tasks and Agent Chat retain their full product models

## Delivered Through

Batch cards collapsed by the flattened-task migration (2026-09-09). Each card below is complete; dispatch and merge evidence lives in `../dispatch.md`, with per-card implementation logs under `../../logs/`.


- `039-operation-authority-mapping.md` — completed (collapsed into this task)
- `040-operation-session-and-presentation.md` — completed (collapsed into this task)
- `041-operation-catalogue-acceptance.md` — completed (collapsed into this task)
