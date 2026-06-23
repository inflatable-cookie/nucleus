# Server Client Gap Matrix

Status: draft
Owner: Tom
Updated: 2026-06-23

## Purpose

Convert the server/client query inventory into implementation candidates.

This matrix is limited to read-only surfaces. It does not authorize provider
execution, provider writes, task mutation, remote transport, or final UI work.

## Gap Groups

### Task Timeline

Current state:

- server query vocabulary exists
- request handler route exists
- tests exist around task work progress and task timeline areas
- serialized control-envelope DTO path exists
- `nucleusd query task-timeline --task <id>` exists
- Effigy selector exists
- desktop proof panel is intentionally deferred

Product value:

- high

Why:

- task timeline is central to task-backed agent work, goal loops, review,
  checkpoints, and multi-client visibility
- it moves Nucleus toward the actual product loop rather than more provider
  readiness panels

Risk:

- moderate; the query may need a task id, so CLI/desktop ergonomics need a
  bounded first shape

Recommended first slice:

- completed through serialized query DTO, CLI, and Effigy inspection
- defer desktop rendering until task/project workflow depth needs it

### Project Authority Map

Current state:

- server query vocabulary exists
- project authority publication records exist
- serialized control-envelope DTO path exists
- `nucleusd query project-authority-map --project <id>` exists
- Effigy selector exists
- desktop proof panel is intentionally deferred

Product value:

- high

Why:

- multi-host Nucleus depends on visible authority ownership
- this hardens the engine-first model without implementing remote transport

Risk:

- moderate; authority records can look like permissions, so all DTOs must say
  they are explanatory read models and do not grant authority

Recommended first slice:

- completed through serialized query DTO, CLI, and Effigy inspection
- defer any mutation, pairing, remote host assignment, or desktop proof panel

### Runtime Readiness And Task Work Progress CLI Parity

Current state:

- desktop proof UI exists
- control-envelope/TS client support exists
- no dedicated `nucleusd query` domains or Effigy selectors

Product value:

- medium

Why:

- useful for inspection, but less central than task timeline and authority-map
  visibility

Recommended first slice:

- defer until after task timeline and authority map unless implementation
  exposes shared helper work for free

### Provider Read Intent And Live-Read Evidence Desktop Parity

Current state:

- server, CLI, Effigy, and control-envelope support exist
- desktop proof UI only renders provider readiness overview

Product value:

- medium-low for the next lane

Why:

- provider execution is intentionally paused
- adding more provider UI now risks keeping momentum in the wrong area

Recommended first slice:

- defer unless provider diagnostics become necessary to validate another
  server/client hardening path

### Workspaces Query Desktop Parity

Current state:

- server state query and CLI/Effigy support exist
- no visible desktop proof UI

Product value:

- medium

Why:

- workspace layout work matters, but the user has not yet set final UI design
  direction and current UI is disposable

Recommended first slice:

- defer until client layout persistence or panel/workspace work becomes the
  selected lane

## Selected Implementation Candidates

Completed:

1. Task timeline read-only control path.
2. Project authority-map read-only control path.

Next candidate:

1. Task/project workflow depth audit and gap matrix.

The next candidate should not implement new task behavior until the task,
project, planning, orchestration, and timeline contracts are mapped to current
code.

## Explicit Non-Goals

- provider command execution
- provider writes
- task mutation
- authority-map mutation
- pairing/auth implementation
- desktop final design
- raw provider or command output retention
