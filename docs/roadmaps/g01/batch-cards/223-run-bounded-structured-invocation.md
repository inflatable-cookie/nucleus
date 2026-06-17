# 223 Run Bounded Structured Invocation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Run the first bounded structured local invocation.

## Scope

- Use executable plus argv, not shell command strings.
- Enforce finite timeout.
- Enforce stdout and stderr byte limits.
- Keep working directory explicit.

## Out Of Scope

- PTY.
- Interactive stdin.
- Shell passthrough.

## Promotion Targets

- `crates/nucleus-server`

## Acceptance Criteria

- A simple read-only command can run.
- Timeout behavior is tested.
- Output bounding behavior is tested.
