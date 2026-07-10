# 136 Task Ledger Portal Consolidation

Status: completed
Owner: Codex
Updated: 2026-07-10
Milestone: `../026-agent-chat-task-context.md`

## Purpose

Replace the atomic task tool menu with one powerful task-ledger portal before
new agent capabilities expand the exposed surface.

## Scope

- expose one `task_ledger` dynamic tool
- support typed inspect, create, and update actions
- retain existing batching, rich task fields, revision safety, provenance, and
  receipts
- keep internal task query and command handlers separate
- migrate existing provider threads through the durable toolset version
- remove the three atomic task tools from provider registration and guidance

## Excludes

- task lifecycle, assignment, dispatch, recovery, or review
- project context and work-evidence actions
- compatibility aliases for the pre-1.0 atomic tool names

## Acceptance

- a provider thread receives only one Nucleus-specific dynamic task tool
- natural creation and refinement requests still reach the existing server
  boundaries
- stale revisions and mixed/invalid action arguments fail closed
- older chat sessions migrate once without losing canonical history
- focused tests and desktop checks pass

## Evidence

- `crates/nucleus-server/src/local_codex_chat/task_ledger.rs`
- `crates/nucleus-server/src/local_codex_chat/runtime.rs`
- `crates/nucleus-server/src/local_codex_chat.rs`
- `cargo test -p nucleus-server local_codex_chat --no-fail-fast`
- authenticated natural create and inspect-update migration smokes
- `effigy desktop:check`
- `effigy qa:docs`
