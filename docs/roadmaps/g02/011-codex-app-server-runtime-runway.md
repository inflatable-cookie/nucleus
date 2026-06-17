# 011 Codex App Server Runtime Runway

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Start the first bridged harness implementation runway with Codex
app-server/runtime.

This milestone should prove adapter registry metadata, schema/probe evidence,
session lifecycle mapping, and canonical event ingestion before broad provider
support.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/research/specimen-dossiers/codex-runtime-boundary.md`
- `docs/research/translation-memos/harness-runtime-target-selection.md`

## Goals

- [x] Verify current Codex app-server schema/protocol evidence before coding
  against T3 assumptions.
- [x] Add Codex app-server adapter registry metadata and ownership descriptors.
- [x] Map Codex thread/session/turn/item/request ids into Nucleus session and
  timeline identity records.
- [x] Add the first canonical runtime event ingestion path for Codex-shaped
  events.
- [x] Keep process spawning, long-lived live sessions, UI panels, SCM mutation,
  and remote client transport out of scope until the gates below pass.

## Execution Plan

- [x] Probe batch: verify local/official Codex app-server method and payload
  shape.
- [x] Registry batch: add metadata-only Codex app-server descriptor and
  readiness/probe records.
- [x] Lifecycle batch: add Codex session lifecycle mapping and identity tests.
- [x] Event batch: add canonical event mapping fixtures for turns, items,
  approvals, user input, and interruption receipts.

## Ready Cards

- `batch-cards/033-codex-app-server-schema-and-probe-evidence.md` - completed
- `batch-cards/034-codex-adapter-registry-descriptor.md` - completed
- `batch-cards/035-codex-session-lifecycle-identity.md` - completed
- `batch-cards/036-codex-event-ingestion-fixtures.md` - completed

## Acceptance Criteria

- [x] Codex app-server implementation work is backed by current schema or
  local probe evidence.
- [x] Codex registry metadata is separate from live runtime state.
- [x] Nucleus ids remain authoritative while Codex ids are retained as
  provider refs.
- [x] Approval, user-input, interruption, and recovery surfaces are represented
  before real live-session execution.
- [x] The Pi comparison target remains visible but unimplemented.

## Gates

Do not start long-lived Codex process supervision until the registry,
lifecycle, event, and receipt mappings can be tested with static fixtures.

Do not add UI behavior in this milestone. Clients consume projections later.

Do not implement Pi RPC in this milestone. Pi is the comparison target after
Codex proves the common spine.

## Outcome

The milestone established a metadata-only Codex app-server runway.

Implemented surfaces:

- current local schema/probe evidence for `codex-cli 0.140.0`
- Codex app-server adapter registry descriptor
- Codex lifecycle and provider-id binding types
- static Codex-shaped event fixture projection
- harness-provider runtime receipt projection for Codex interruption fixtures

No live Codex process supervision, long-lived session execution, UI behavior,
SCM mutation, or remote client transport was added.

The next runway should decide whether to proceed into live Codex runtime
supervision, return to `g02/010` client transport, or do a short milestone
reassessment first.
