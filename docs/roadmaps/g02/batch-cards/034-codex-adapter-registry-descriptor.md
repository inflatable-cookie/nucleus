# 034 Codex Adapter Registry Descriptor

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../011-codex-app-server-runtime-runway.md`

## Purpose

Add metadata-only Codex app-server adapter registry descriptors.

## Scope

- Add Codex app-server driver/instance metadata in the appropriate Rust crate.
- Represent runtime ownership: external app-server, nucleus-owned scoped local
  process, or unavailable/unknown.
- Represent transport: app-server stdio first, WebSocket/Unix socket as later
  transports where supported.
- Represent readiness/probe policy without spawning a live session.
- Keep secret refs and auth material out of registry records.

## Acceptance Criteria

- Codex app-server descriptor can be listed and resolved without launching
  Codex.
- Descriptor includes provider kind, transport, ownership, readiness,
  capability snapshot, and probe requirements.
- Tests prove descriptor metadata is separate from live runtime state.

## Validation

- `cargo test -p nucleus-agent-adapters`
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if the current crate boundary is too vague for registry ownership.
- Stop if descriptor work starts spawning Codex or reading credentials.

## Outcome

Added `crates/nucleus-agent-adapters/src/codex.rs` with a metadata-only Codex
app-server descriptor, schema evidence, whitelisted method subset, probe
policy, and registry fixture.

The descriptor records structured app-server transport, nucleus-owned local
server ownership, readiness gates, and capabilities without spawning Codex,
creating sessions, or storing secret material.
