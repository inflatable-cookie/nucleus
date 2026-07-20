# 049 Swallowtail Agent Chat Adoption

Status: completed
Owner: Tom
Updated: 2026-07-20

## Purpose

Replace Nucleus Agent Chat's direct Codex app-server transport with
Swallowtail behind the existing consumer facade.

## Governing Refs

- `../../contracts/030-swallowtail-agent-runtime-integration-contract.md`
- `../../contracts/017-engine-host-authority-contract.md`
- `../../contracts/019-conversation-timeline-contract.md`
- `../../contracts/024-harness-mediation-tool-projection-contract.md`

## Execution Plan

- [x] Promote the consumer authority, lifecycle, tool, identity, and rollback
  boundary.
- [x] Replace model discovery, session open, turns, callbacks, deadlines, and
  cleanup behind `AgentSessionRuntime`.
- [x] Remove the superseded direct app-server transport and prove automated
  parity.
- [x] Prove native parity through the authenticated Agent Chat product surface.

## Goals

- [x] Swallowtail owns reusable Codex communication for Agent Chat.
- [x] Nucleus keeps its existing product-facing chat and tool boundaries.
- [x] Stored tool-enabled history migrates into a fresh session safely.
- [x] Provider settings and other execution paths remain outside this slice.

## Acceptance Criteria

- [x] exactly one `codex-app-server` implementation is registered
- [x] model and reasoning DTOs remain compatible
- [x] both Nucleus portals round-trip through Swallowtail callbacks
- [x] session/turn/provider/callback/task/receipt identities stay distinct
- [x] timeout and cleanup retain explicit outcomes
- [x] no direct app-server wire implementation remains in
  `nucleus-agent-adapters`
- [x] native Agent Chat acceptance is recorded

## Batch Cards

- `batch-cards/220-swallowtail-consumer-boundary-promotion.md` — completed
- `batch-cards/221-swallowtail-agent-chat-transport.md` — completed
- `batch-cards/222-swallowtail-agent-chat-validation.md` — completed

## Planning Checkpoint

The post-acceptance inventory is recorded in roadmap 050. It found one live
product task transport, one diagnostic smoke transport, and no wire transport
inside the Nucleus supervision model.

## Stop Condition

Reopen the lane if Agent Chat adoption moves Nucleus tools, receipts,
persistence, projects, tasks, Goals, memory, or host-placement policy into
Swallowtail.
