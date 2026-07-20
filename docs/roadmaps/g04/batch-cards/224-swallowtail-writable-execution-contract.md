# 224 Swallowtail Writable Execution Contract

Status: completed
Owner: Tom
Updated: 2026-07-20
Milestone: `../050-swallowtail-task-execution-adoption.md`
Auto-start next card: no

## Objective

Promote the smallest cross-repo contract that lets Swallowtail host a bounded
writable Codex task session without widening read-only Agent Chat.

## Acceptance

- [x] Nucleus names the task-executor consumer facade and retained domain
  ownership
- [x] Swallowtail names explicit read-only and bounded-workspace access modes
- [x] approval, writable-root, provider-network, callback, deadline, and
  cleanup semantics are explicit
- [x] route, resource, session, task, work-item, turn, and receipt identities
  remain distinct
- [x] remote-authoritative execution remains blocked pending host routing
- [x] both repos carry aligned roadmap and contract references before code

## Stop Condition

Stop if one boolean such as `writable` would hide approval, network, writable
root, or host-placement policy.
