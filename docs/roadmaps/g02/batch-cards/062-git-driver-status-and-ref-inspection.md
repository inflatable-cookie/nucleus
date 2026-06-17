# 062 Git Driver Status And Ref Inspection

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../017-scm-working-copy-and-change-request-workflows.md`

## Purpose

Implement the first Git-backed inspection records through neutral SCM driver
vocabulary.

## Scope

- Add Git status/ref inspection records behind neutral SCM types.
- Keep dirty state, branch refs, detached HEAD, and upstream refs explicit.
- Avoid commit-only assumptions in neutral records.
- Do not mutate the working copy.

## Acceptance Criteria

- [x] Git inspection can represent clean, dirty, detached, and missing-upstream
  states.
- [x] Neutral records do not require every SCM to have Git commits.
- [x] Inspection is read-only.

## Outcome

Added `nucleus-scm-forge::git_inspection` as a read-only, record-only
projection layer.

Git status snapshots now project into provider-neutral working-copy inspection
records covering:

- branch and detached head state
- tracked, missing, not-applicable, and unknown upstream state
- clean and code-changed dirty state
- path statuses
- missing-upstream, detached-head, and unborn-head issues

The implementation does not run Git or mutate a working copy.

## Validation

- [x] `cargo test -p nucleus-scm-forge`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if read-only Git inspection requires mutation or credential policy.
