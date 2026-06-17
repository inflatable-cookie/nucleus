# 154 Add Command Evidence Query Output

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Add `nucleusd` output for command evidence records.

## Scope

- Extend query parsing with command evidence.
- Decode command evidence storage records for display.
- Print status, retention, exit status, artifact refs, and summary.

## Out Of Scope

- Raw process transcript output.
- Artifact payload reads.
- Desktop UI.

## Promotion Targets

- `apps/nucleusd`

## Acceptance Criteria

- `nucleusd query command-evidence` prints sanitized records.
- Raw stdout/stderr is not printed.
- Unsupported query domains still fail visibly.

## Closeout

- Added `query command-evidence`.
- Query output decodes stored evidence and prints status, retention, refs, and
  summary without raw output.
