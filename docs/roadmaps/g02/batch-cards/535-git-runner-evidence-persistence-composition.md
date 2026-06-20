# 535 Git Runner Evidence Persistence Composition

Status: planned
Owner: Tom
Updated: 2026-06-20
Milestone: `../114-git-read-only-runner-evidence-composition.md`

## Purpose

Persist composed Git dry-run execution records from sanitized runner evidence.

## Scope

- Feed composed capture records into existing Git dry-run execution persistence.
- Preserve stable ordering and duplicate blocking.
- Keep raw output transient only.

## Acceptance Criteria

- [ ] Composed records persist through existing persistence path.
- [ ] Duplicates are blocked.
- [ ] Evidence refs survive reopen.
- [ ] Raw output and mutation authority remain blocked.

## Validation

- `cargo test -p nucleus-server git_runner_evidence_persistence_composition -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
