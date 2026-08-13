# 101 Run Delivery Pipeline

Status: dispatched
Owner: Tom
Created: 2026-08-13
Milestone: none yet (agent orchestration lane, phase 1)
Depends on: 098 (run registry), 099 (operator-dispatched runs)
Auto-start next card: no

## Objective

Close the run loop: when a worker finishes, capture the closeout, run the
validation hook, commit and push the run branch, notify the operator, and
transition the run to `delivered`. Operator review and merge stay manual in
phase 1 (review rides the existing diff/review workflow); forge PR creation
is a later card.

## Governing Refs

- Contract 033 (draft) — Delivery Rule and the 2026-08-13 no-forge
  decision: delivery packet = closeout + branch (pushed where a remote
  exists) + notification; a missing forge never blocks delivery
- Contract 020 — receipts for every side effect (commit, push, notify)
- Cards 011-013 — staging and local commit machinery to reuse
- Card 097 — the notification routing precedent (host publishes; warning
  severity for failures, info/success for deliveries)

## Scope (planned)

- Closeout capture: the worker's final summary + evidence (validation
  output, changed-file summary) bound into the run record; a run without a
  closeout cannot reach `delivered`.
- Validation hook: the project/repo's standard check (per AGENTS.md /
  effigy tasks) runs in the run worktree; its result is recorded in the
  closeout, pass or fail.
- Commit + push: stage, commit (message references the run id), push to the
  project remote when one exists; each step receipted; push failure does
  not block `delivered` (branch remains local, receipt explains).
- Operator notification on delivery and on pipeline failure, via the
  096-097 notification path.
- Operator `accept` / `reject` dispositions on delivered runs (registry
  transitions only — no merge automation).

Out of scope: PR creation, merge automation, orchestrator review (phase 3),
the delivery-review UI surface (a phase-2 candidate).

## Acceptance (planned)

- [ ] finished worker → closeout + validation + commit/push + notification
  → `delivered`, each side effect receipted
- [ ] no-remote projects still deliver (local branch + notification)
- [ ] push failure keeps the run deliverable with an explaining receipt
- [ ] accept/reject transitions work; fixtures + suites green; batch log

## Stop Conditions

- Committing in a run worktree requires authority beyond cards 011-013's
  admission (e.g. signing, policy gates) → stop with citations
- The validation hook cannot run safely in a worktree → stop and report
