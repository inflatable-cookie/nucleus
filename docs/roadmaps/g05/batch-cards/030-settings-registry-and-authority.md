# 030 Settings Registry And Authority

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../010-longhorn-settings-shell.md`
Depends on: card 029
Auto-start next card: yes

## Objective

Register bounded Nucleus settings pages and typed apply units through the
Longhorn registry while retaining product schemas and effects in Nucleus.

## Acceptance

- [x] one sealed registry generation contains only admitted Nucleus pages
- [x] page visibility, search metadata, apply mode, and authority are typed
- [x] staged and immediate settings cannot write outside their domain
- [x] unsupported and unavailable pages remain explicit

## Validation

- [x] deterministic registry and authority fixtures pass
- [x] stale-generation and duplicate-registration cases fail closed

## Stop Conditions

- do not put credentials, provider payloads, or product state in Longhorn documents

## Evidence

- generation 1 seals General and Appearance under one Nucleus module and
  capability
- immediate General and staged Appearance units project one typed Nucleus
  preferences domain without cross-unit patch authority
- seven focused Rust fixtures cover duplicate registration, stale generation,
  cross-domain commands, stale authority, restart, reset, durability failure,
  and caller authorization
- the host adapter accepts a generic Tauri webview and authorizes its parent
  window, so native Browser child webviews do not invalidate Settings IPC
