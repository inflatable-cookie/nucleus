# Server Client Query Surface Inventory

Status: draft
Owner: Tom
Updated: 2026-06-23

## Purpose

Inventory read-only query/control surfaces before server/client hardening work.

This is not a UI plan. It records which server-owned read models can already be
reached by `nucleusd`, Effigy, Tauri IPC, and the desktop proof shell.

## Rules

- clients render state, they do not own authority
- query surfaces must remain read-only unless a separate command contract
  grants mutation
- provider reads and writes remain blocked unless a specific roadmap grants an
  operator-approved smoke or execution lane
- raw provider payloads, credentials, raw command output, and task mutation are
  out of scope for this inventory

## Surface Matrix

| Surface | Server query/handler | Control envelope | `nucleusd` | Effigy task | Tauri IPC fixture | Desktop proof UI | Provider effect-free |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Projects | yes: state query | yes: state DTO | yes | yes | yes | yes | yes |
| Tasks | yes: state query | yes: state DTO | yes | yes | yes | yes | yes |
| Workspaces | yes: state query | yes: state DTO | yes | yes | not visibly proven | no | yes |
| Command evidence | yes: runtime metadata | yes: typed response | yes | yes | not visibly proven | yes | yes |
| Runtime readiness | yes: runtime metadata | yes | no dedicated CLI query | no dedicated task | yes | yes | yes |
| Task work progress | yes: runtime metadata | yes | no dedicated CLI query | no dedicated task | yes | yes | yes |
| Diagnostics aggregate | yes: diagnostics query | yes | no dedicated CLI query | no dedicated task | yes | yes | yes |
| Provider read intent | yes | yes | yes | yes | yes | no | yes |
| Provider readiness overview | yes | yes | yes | yes | yes | yes | yes |
| Provider live-read executor diagnostics | yes | yes | yes | yes | not visibly proven | no | yes |
| Provider live-read smoke evidence diagnostics | yes | yes | yes | yes | not visibly proven | no | yes |
| Task timeline | yes | no first-envelope DTO found | no | no | no | no | yes |
| Project authority map | yes | no first-envelope DTO found | no | no | no | no | yes |
| Adapter/session queries | type vocabulary only | no | no | no | no | no | yes |
| Model route queries | type vocabulary only | no | no | no | no | no | yes |
| Event replay | query type exists | no visible first-envelope path | no | no | no | no | yes |

## Observations

- The server query vocabulary is broader than the serialized first control
  envelope.
- `nucleusd query` is strongest for state records and provider-read surfaces.
- The desktop proof shell renders projects, tasks, runtime readiness, task work
  progress, provider readiness, command diagnostics, and diagnostics proof
  panels.
- Provider read intent and live-read evidence are CLI/Effigy visible, but not
  desktop-visible.
- Task timeline and project authority map are server/query concepts but are
  not yet first-envelope or CLI/Desktop surfaces.
- Runtime readiness and task work progress have desktop consumption but no
  dedicated `nucleusd query`/Effigy selectors.

## First Hardening Candidates

Best candidates for the next gap matrix:

- task timeline: high product value, directly supports task/project workflow
  depth, currently lacks CLI/Tauri/Desktop parity
- project authority map: high architecture value for multi-host workflows,
  currently lacks CLI/Tauri/Desktop parity
- provider live-read smoke evidence: already server/CLI/Effigy/control-envelope
  visible, but desktop proof UI is missing; lower value than task/authority
  coherence unless provider diagnostics remains the active lane

Recommended first selection:

- task timeline and project authority map as read-only surfaces

Reason:

- they advance product workflow coherence without adding provider execution
- they support future multi-host and task-backed agent work
- they reduce the risk that provider diagnostics becomes the only polished
  client path

## Non-Goals

- final UI layout
- remote transport
- auth/pairing implementation
- provider command execution
- provider writes
- task mutation
- raw payload display
