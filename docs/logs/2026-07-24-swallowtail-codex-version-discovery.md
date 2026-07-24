# Swallowtail Codex Version Discovery

Date: 2026-07-24

## Outcome

Nucleus now satisfies Swallowtail's exact executable-version contract for
every Codex path:

- Agent Chat
- model catalogue
- confirmed read-only smoke
- bounded task execution

Each path probes the host-approved Codex executable through Swallowtail before
building its preflight plan. Nucleus promotes the exact observed `codex.cli`
binding into both the configured instance and operation requirements.
Discovery failure stops before app-server launch.

The local host resolves Codex to an absolute executable path before approving
the opaque target. This lets Swallowtail's intentionally environment-free
version probe execute the same binary as the later saved-login session without
depending on ambient PATH inside the child process.

Resolution skips script launchers such as injected terminal wrappers and npm
entry points. Those launchers depend on PATH to locate an interpreter or
downstream binary and cannot satisfy the environment-free installed executable
contract. A direct standalone binary is selected for both discovery and the
later app-server process.

Nucleus also binds Swallowtail's explicit `Ambient`
harness-configuration posture into the configured instance and every Codex
operation. This records the existing saved-login invocation honestly without
granting configuration-management authority.

Agent Chat and the confirmed smoke now apply the same canonical read-only
session access policy to immutable preflight and session open. Swallowtail's
ambient default is no longer allowed to stand in for Nucleus's requested
read-only boundary.

Tool-free sessions no longer claim the dynamic-tool capability. Agent Chat
binds that capability only when its product tools are actually declared; the
confirmed no-tool smoke remains exactly tool-free.

No latest-known version is hardcoded. The local checkout currently reports
Codex CLI `0.145.0`; Swallowtail remains responsible for classifying that
observation against its compatibility claim.

## Evidence

- the normal Swallowtail Codex adapter suite passes
- the opt-in installed-Codex probe passes through Nucleus's real local host
- the authenticated model catalogue clears live preflight, app-server
  initialization, listing, and cleanup
- an authenticated read-only Agent Chat session with a dynamic tool clears
  discovery, preflight, session open, and cleanup without sending a turn
- `cargo check -p nucleus-agent-adapters` passes
