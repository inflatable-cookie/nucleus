# 243 Add Nucleusd Command History Query Output

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Print command history through `nucleusd` using the sanitized response shape.

## Scope

- Reuse existing `query command-evidence` command or add a clearer alias.
- Print evidence id, request id, status, exit status, retention, refs, and
  sanitized summary.

## Out Of Scope

- Raw stdout/stderr.
- Rich terminal UI.

## Promotion Targets

- `apps/nucleusd`

## Acceptance Criteria

- CLI output is stable.
- Raw output remains absent.

## Outcome

`nucleusd query command-evidence` now renders the sanitized response DTO rather
than decoding storage payloads directly.
