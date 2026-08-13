# 103 Run Delivery Forge Pull Requests

Status: completed
Owner: Tom
Created: 2026-08-13
Milestone: none yet (agent orchestration lane, phase 2)
Depends on: 101 (run delivery pipeline, merged `bbe74b7e`), 107 (forge
  PR-creation authority, merged `c1927e31`)
Auto-start next card: no

## Authority Gate (resolved 2026-08-13)

First dispatch stopped on the PR-creation gate (stop log
`docs/logs/2026-08-13-run-delivery-forge-pull-requests.md`, merged
`dfbac4c0`). Card 107 opened it: contract 027's per-delivery PR-creation
lane, the delivery intent's `pull_request_creation` scope, and
`run_forge_pull_request_creation`
(`provider_forge_pull_request_runner_authority/execution.rs`) with
provider-state reconciliation and replay. Wire the pipeline to that path —
after the gated push, invoke PR creation under the confirmed intent, append
`delivery:pr-reference` evidence to the run closeout, and surface the link
in the operator notification. Never a bare forge call.

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

- [x] forge-backed projects deliver as PRs linked from the run record
- [x] no-forge/no-credential projects keep the 101 packet with an
  explaining receipt
- [x] PR API failure leaves the branch delivered and records the failure
- [x] fixtures + suites green; batch log

## Closeout

Merged to main as `01a52221` (flash xhigh, second dispatch after the 107
gate opened). The delivery pipeline now invokes the 107 PR-creation lane
after the gated push under the confirmed intent, appends
`delivery:pr-reference` evidence to the closeout, and surfaces the link in
the host notification. Honest route caveat: the admitted forge adapter is
the test double — real forge routes report `ProviderUnavailable` (recorded
with a receipt; branch-only delivery stands) until a real provider route
lands its own lane per contract 027. Merge conflicts with 102's DTO union
were resolved by the orchestrator (both variants kept, `base_ref` fixture
updated, bindings regenerated). First dispatch stopped on the PR-creation
gate (stop log merged `dfbac4c0`); 107 opened it.

## Stop Conditions

- Contract 027's admission does not cover agent-initiated PR creation →
  stop with citations; this becomes a contract amendment first
