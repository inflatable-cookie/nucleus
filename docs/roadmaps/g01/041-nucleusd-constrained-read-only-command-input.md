# 041 Nucleusd Constrained Read-Only Command Input

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Expose the read-only command control API through a constrained `nucleusd` CLI
path without adding shell passthrough or write-capable execution.

## Scope

- Add a structured CLI command for read-only execution.
- Require executable and argv to remain separate.
- Require explicit working directory, timeout, and output limits or safe
  defaults.
- Print the sanitized read-only command result.
- Keep evidence query behavior usable after execution.

## Out Of Scope

- Desktop UI controls.
- PTY or terminal streaming.
- Shell command strings.
- Write-enabled commands.
- Remote execution.

## Decisions

- CLI input should use structured args, not a shell string.
- The CLI may provide safe defaults for timeout and output limits.
- The CLI should print the sanitized result and never print raw stdout/stderr.
- Desktop should wait until the CLI path proves the interaction shape.

## Execution Plan

- [x] Define constrained CLI syntax.
- [x] Add CLI parsing for structured read-only command input.
- [x] Route CLI input through the control API handler.
- [x] Print sanitized read-only command results.
- [x] Reassess desktop command panel readiness.

## Acceptance Criteria

- `nucleusd` can run a constrained read-only command supplied by the operator.
- Shell passthrough remains rejected.
- Raw stdout/stderr are not printed.
- Evidence is persisted and queryable.
- Next desktop lane is explicit.

## Cards

- `docs/roadmaps/g01/batch-cards/236-define-constrained-read-only-cli-syntax.md`
- `docs/roadmaps/g01/batch-cards/237-add-read-only-command-cli-parser.md`
- `docs/roadmaps/g01/batch-cards/238-route-cli-read-only-command-through-control-handler.md`
- `docs/roadmaps/g01/batch-cards/239-print-sanitized-read-only-command-result.md`
- `docs/roadmaps/g01/batch-cards/240-reassess-desktop-command-panel-readiness.md`

## Closeout

Implemented constrained structured read-only command input in `nucleusd`.

- CLI syntax is `command-runner read-only [flags] -- <executable> [args...]`.
- Parser keeps flags before `--` and executable/argv after `--`.
- Safe defaults are timeout `2000ms`, stdout limit `16384`, stderr limit
  `16384`, and current working directory.
- The CLI routes through `LocalControlRequestHandler` and
  `ServerCommandKind::ReadOnlyCommand`.
- Printed output is sanitized result metadata only.
- `server:command-runner:read-only` runs a fixed structured Effigy smoke.

Desktop command panel work should wait. The next server lane should improve
command evidence/history query shape so operator-facing clients can inspect
past runs without raw output.
