# Harness Runtime Target Selection

Status: active
Owner: Tom
Updated: 2026-06-17

## Purpose

Choose the first bridged harness runtime target for Nucleus and one comparison
target that stresses different adapter assumptions.

This memo does not authorize provider runtime implementation by itself. It
feeds `docs/roadmaps/g02/009-harness-runtime-target-selection.md` and the
follow-on implementation runway.

## Selection Criteria

The first target should prove:

- stable provider session identity
- structured event ingestion
- turn, item, tool-call, approval, and user-input mapping
- cancellation or interruption
- resume or recovery
- runtime receipts for side effects
- checkpoint/diff linkage without owning SCM mutation
- Rust-owned orchestration with minimal non-Rust bridge complexity

The comparison target should stress a different identity and transport shape.

## Candidate Comparison

| Candidate | Strength | Main risk | Selection role |
| --- | --- | --- | --- |
| Codex app-server/runtime | Rich structured protocol, app-server docs, thread/turn/item ids, approvals, resume, fork, rollback/read surfaces, T3 specimen | Protocol details must be verified against current schema/local runtime before implementation | First target |
| Claude SDK sidecar | Strong structured SDK, permissions, sessions, AskUserQuestion, hooks, MCP | TypeScript/Python sidecar and Claude subprocess ownership add bridge complexity | Deferred bridged target |
| Cursor CLI ACP | Good ACP proving ground, local CLI route, T3 specimen | Current docs need local initialize probe; ACP extension methods need mapping decisions | Deferred ACP target |
| OpenCode server/SDK | Rich server API, events, permissions, diff/revert/fork, T3 specimen | Server ownership, SDK sidecar, and OpenCode-specific feature breadth make it bigger than first target | Deferred server/SDK target |
| Kimi ACP | Strong ACP feature coverage, session load/resume, approvals/questions, file reverse-RPC | Event identity and terminal/shell behavior need current local probe; second ACP target after core runtime shape | Deferred ACP target |
| Pi RPC | Simple JSONL RPC, language-agnostic, strong session files, explicit event stream | Events lack ids; sandbox is external/none unless Nucleus wraps the process | Comparison target |
| Nucleus-native steward | App-owned authority, tool-first, good fit for Effigy/task sync | Does not prove bridged provider communication; belongs in native harness lane | Parallel native target |

## Decision

First bridged harness target: Codex app-server/runtime.

Reason:

- It exercises the exact Nucleus runtime spine: session lifecycle, event
  ingestion, approvals, user input, cancellation/interruption, resume, read,
  rollback/fork evidence, and runtime receipts.
- It is structured enough to avoid PTY-first ambiguity.
- It can be driven from Rust over process stdio or another app-server
  transport without making TypeScript sidecar architecture the first problem.
- T3 Code provides a local specimen, but the official app-server docs and
  generated/local schema must remain the implementation authority.

Comparison target: Pi RPC.

Reason:

- It is also language-agnostic and process-owned, but has a weaker event
  identity model.
- It forces Nucleus to prove synthetic event identity, stream generation ids,
  session-file replay namespaces, and capability honesty.
- It keeps the comparison compact. OpenCode, Claude, Cursor, and Kimi each add
  more provider-specific surface than needed for the first contrast.

Native target posture: Nucleus-native steward remains a parallel app-owned
runtime lane, not the first bridged harness target.

## Implementation Implications

The next harness implementation runway should start with Codex app-server
metadata/probe and event-schema work, not direct full session execution.

Required first gates:

- adapter instance record can describe Codex app-server ownership and
  readiness
- local schema or protocol probe confirms methods and event payloads
- session lifecycle records map Codex thread/session ids without replacing
  Nucleus ids
- runtime event ingestion maps provider refs into canonical timeline events
- approval and user-input requests become server-owned wait states
- interruption/cancellation records produce runtime receipts
- provider rollback/fork/read surfaces stay explicit capabilities
- terminal fallback remains fallback, not the primary structured event source

Pi should not be implemented in the same milestone. It should remain the
comparison target for the next adapter once Codex proves the common spine.
