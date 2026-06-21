# 007 Git Change Request Dry-Run Handoff

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../002-git-change-request-dry-run-runner.md`

## Purpose

Define runner handoff records for Git change-request dry-run requests that
passed preflight.

## Scope

- Preserve preflight and request refs.
- Admit handoff only for ready preflights.
- Keep shell execution false.
- Keep Git mutation and forge effects false.

## Acceptance Criteria

- [x] Handoff records reference preflight ids.
- [x] Non-ready preflights are blocked.
- [x] Handoff does not contain raw command output.
- [x] No Git or forge effect is executed.

## Validation

- [x] `cargo test -p nucleus-server git_change_request_dry_run_handoff -- --nocapture`
- [x] `cargo check --workspace`
- [x] `git diff --check`
