# 103 Run Delivery Forge Pull Requests

Status: dispatched
Owner: Tom
Created: 2026-08-13
Milestone: none yet (agent orchestration lane, phase 2)
Depends on: 101 (run delivery pipeline)
Auto-start next card: no

## Objective

Where a project has a forge remote, delivery opens a real pull request
instead of the branch-only packet: title and body from the closeout, linked
to the run record, and the PR reference stored on the run.

## Governing Refs

- Contract 033 (draft) — Delivery Rule
- Contracts 011 + 027 — SCM/forge rules and forge network execution
  authority; PR creation is a forge write and must satisfy 027's admission
- `docs/research/source-hubs/scm-forge-implementation.md` — forge evidence
- The 2026-08-13 decision: operator merges; this card creates PRs, never
  merges them

## Scope (planned)

- Forge PR creation in the delivery pipeline when a forge remote is
  configured: branch pushed (101 machinery), PR opened with the closeout as
  body, PR URL/reference persisted on the run, notification includes the
  link.
- Forge admission per contract 027; absence of forge credentials or a
  remote falls back to the 101 branch-only packet with a receipt saying
  why.
- Fixtures: PR-open happy path against the forge test double, fallback
  paths (no remote, no credentials, PR API failure).

Out of scope: merge automation, PR review comment sync, stacked runs.

## Acceptance (planned)

- [ ] forge-backed projects deliver as PRs linked from the run record
- [ ] no-forge/no-credential projects keep the 101 packet with an
  explaining receipt
- [ ] PR API failure leaves the branch delivered and records the failure
- [ ] fixtures + suites green; batch log

## Stop Conditions

- Contract 027's admission does not cover agent-initiated PR creation →
  stop with citations; this becomes a contract amendment first
