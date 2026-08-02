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

### Batch 13.1 — Authority Mapping

- [x] Execute card 039.
- [x] start with Forge, resource, indexing, and recovery-shaped fixtures
- [x] exclude provider questions, plans, Tasks, and transcript detail

### Batch 13.2 — Renderer Projection

- [x] Execute card 040.
- [x] add one isolated Svelte session and compact Poodle presentation
- [x] keep cancellation requests distinct from confirmed cancellation

### Batch 13.3 — Operation Acceptance

- [x] Execute card 041.
- [x] prove races, retry lineage, remount, project switch, and shutdown
- [x] verify no duplicate durable authority

## Acceptance Criteria

- [x] active work remains visible outside its originating panel
- [x] terminal state is sticky and late progress cannot reopen work
- [x] cancellation receipts do not fabricate stopped execution
- [x] renderer teardown does not cancel host work
- [x] Tasks and Agent Chat retain their full product models

## Batch Cards

- `batch-cards/039-operation-authority-mapping.md`
- `batch-cards/040-operation-session-and-presentation.md`
- `batch-cards/041-operation-catalogue-acceptance.md`
