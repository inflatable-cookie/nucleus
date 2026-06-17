# 239 Print Sanitized Read-Only Command Result

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Print read-only command results without raw output.

## Scope

- Print status, exit status, evidence id, byte counts, truncation flags, and
  rejection category.
- Keep raw stdout/stderr unavailable.
- Keep command evidence query compatible.

## Out Of Scope

- Rich terminal UI.
- Streaming output.
- Artifact payload display.

## Promotion Targets

- `apps/nucleusd`

## Acceptance Criteria

- Output is stable and sanitized.
- Tests prove raw command output is not printed.

## Closeout

The CLI prints command id, request id, evidence id, status, retention, exit
status, event count, byte counts, truncation flags, rejection category, and
sanitized summary.

It does not print raw stdout or stderr.
