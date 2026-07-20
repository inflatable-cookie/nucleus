# 225 Swallowtail Writable Session Driver

Status: completed
Owner: Tom
Updated: 2026-07-20
Milestone: `../050-swallowtail-task-execution-adoption.md`
Auto-start next card: no

## Objective

Implement contract-backed bounded-workspace session policy and deterministic
Codex driver evidence in Swallowtail.

## Acceptance

- [x] read-only defaults remain unchanged
- [x] bounded writable roots and denied provider network map exactly
- [x] unsupported approvals and callbacks terminate explicitly
- [x] deadlines, terminal outcomes, interruption, and cleanup are tested
- [x] no Nucleus domain type enters Swallowtail

## Evidence

- Swallowtail roadmap 010 and cards 031-034 are complete.
- `swallowtail-core::session_access` and runtime preflight bind independent
  resource, filesystem, approval, network, search, and provider-request policy.
- Codex workspace fixtures assert one host-resolved writable root,
  `workspace-write`/`workspaceWrite`, denied network, ambient temporary-root
  exclusions, and approval posture `never`.
- provider approval and user-input requests retain correlation, receive an
  explicit rejection, interrupt the turn, and terminate as observed requests.
- local and remote-authoritative conformance passes without consumer types in
  shared crates.
- Swallowtail's `nucleus-task-execution-handoff.md` records the exact consumer
  seam for card 226.

## Stop Condition

Stop if the provider schema cannot express the contracted policy without
granting broader filesystem or network access.
