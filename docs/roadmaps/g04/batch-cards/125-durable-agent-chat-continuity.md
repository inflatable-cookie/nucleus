# 125 Durable Agent Chat Continuity

Status: completed
Owner: Tom
Updated: 2026-07-09
Milestone: `../025-initial-agent-chat-vertical-slice.md`

## Purpose

Make the accepted Agent Chat conversation survive desktop and server-runtime
restart before linking it to tasks.

## Scope

- persist Nucleus session, turn, and ordered user/assistant message records
- store provider thread id as an external session ref
- hydrate the Agent Chat panel from server-owned history
- resume the persisted Codex thread after local service restart
- move desktop state from a temporary database to
  `~/.nucleus/state/nucleus.sqlite`
- preserve the fixed `gpt-5.4-mini` low-reasoning session override
- split chat service, persistence, and Codex transport modules

## Acceptance

- persisted history survives SQLite reopen
- a live Codex turn resumes the same provider thread after service restart
- Svelte and Rust checks pass
- workspace shell and task state remain unchanged
