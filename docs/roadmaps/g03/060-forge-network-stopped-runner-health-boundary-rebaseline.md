# 060 Forge Network Stopped Runner Health Boundary Rebaseline

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Rebaseline the stopped forge network execution chain before any real
credential resolution or provider network call.

This lane checks that provider-auth admission, forge network preflight,
request/receipt, outcome persistence, and stopped pull-request request
preparation remain bounded as sanitized record/control surfaces.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/contracts/020-runtime-receipt-contract.md`
- `docs/roadmaps/g03/059-stopped-forge-network-outcome-persistence-control.md`
- `docs/architecture/implementation-gap-index.md`

## Goals

- [x] Refresh focused test evidence for forge network execution records.
- [x] Refresh focused test evidence for stopped forge pull-request runner
  request-preparation records.
- [x] Audit code for accidental network/process/provider execution tokens.
- [x] Record line-count pressure without making refactor churn.
- [x] Select the next bounded provider-auth lane.

## Execution Plan

- [x] Forge network evidence refresh.
- [x] Stopped PR runner dependency evidence refresh.
- [x] Boundary authority audit.
- [x] Warning pressure triage.
- [x] Next lane selection and validation closeout.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/214-forge-network-health-evidence-refresh.md`
- `batch-cards/215-forge-network-boundary-authority-audit.md`
- `batch-cards/216-forge-network-warning-pressure-triage.md`
- `batch-cards/217-next-provider-credential-status-lane-selection.md`
- `batch-cards/218-forge-network-rebaseline-validation-closeout.md`

## Evidence

Focused tests:

- `cargo test -p nucleus-server forge_network_execution -- --nocapture`
  passed, 20 tests.
- `cargo test -p nucleus-server forge_pull_request_runner -- --nocapture`
  passed, 10 tests.

Boundary token audit:

- no matches in the forge network execution or stopped PR runner modules for
  direct HTTP/process/network-call tokens such as `reqwest`, `ureq`, `hyper`,
  `octocrab`, `graphql`, `curl`, `gh api`, `Command::new`, or true effect
  flags for credential resolution, provider calls, forge/provider effects,
  callbacks, interruption, recovery, task mutation, or raw provider payload
  retention.

Warning pressure:

- warning-sized files remain in tests and type surfaces for the current stopped
  forge network lane.
- the pressure is acceptable for now because these files are fixture-heavy and
  the active lane should not refactor them without changing behavior.

## Acceptance Criteria

- [x] Focused forge network execution tests pass.
- [x] Focused stopped PR runner tests pass.
- [x] No direct network/process/provider execution tokens are present in the
  audited modules.
- [x] Existing line-count pressure is documented as warning-only.
- [x] Next lane remains stopped by default.

## Closeout

Forge network execution is still a stopped record/control proof.

The next lane should model provider credential-status refresh records from
credential refs without resolving credential material or calling provider
networks.
