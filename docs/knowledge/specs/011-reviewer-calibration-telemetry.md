# 011 — Reviewer calibration telemetry

Status: implemented
Owner: Nucleus telemetry and review maintainers
Created: 2026-09-15
Governing refs: `docs/knowledge/contracts/orchestration.md`,
`docs/knowledge/contracts/durable-telemetry.md`,
`docs/knowledge/specs/009-shared-telemetry-snapshot-and-metric-repair.md`

## Problem

Reviewer routes show sharply different raw `changes_required` rates, but task
assignment is confounded. Nucleus cannot yet connect a reviewer verdict to later
revision success, a pre-merge refusal or a post-merge incident. Raw rates are
therefore unsafe evidence for pool-weight changes.

## Attribution contract

For every accepted review, durably correlate the review event, run and exact
head with reviewer agent, profile, provider, model and profile group. Link only
facts Nucleus can prove:

- verdict and accepted exact head;
- later semantic revision cause, run and resulting head;
- later accepted independent review;
- exact-head pre-merge result or refusal;
- post-merge incidents and their normalized semantic or operational cause.

Use task scope and explicit stored routing dimensions. Never infer class,
quality or document meaning from repository names, titles, summaries or prose.
Older evidence without an exact link is partial, not guessed.

Expose cohort and time filters plus reviewer provider, profile and profile-group
filters distinct from worker routing. Aggregate verdict counts, revision return
and resolution, pre-merge refusal after `ready_to_merge`, and post-merge semantic
and operational incidents. Present these as calibration signals, not reviewer
scores or causal claims.

## Shadow-review experiment plan

No shadow reviews are enabled by this task. A later operator-approved experiment
may use one non-authoritative, read-only review at the same exact head after the
authoritative verdict. It must have a named experiment ID, explicit eligibility,
one shadow per sampled task, a fixed start/end, a daily cap no greater than five,
and a sample rate no greater than ten percent.

The shadow profile must be independent of the worker and authoritative reviewer.
Its result is stored as calibration evidence only: it cannot comment on the PR,
block, revise, merge, notify, spend a task revision round or delay normal work.
Default configuration remains disabled. Enabling any experiment or model spend
requires a separate operator decision and versioned control.

## Acceptance oracle

- Exact reviewer identity and verdict link to later revision, re-review,
  pre-merge and post-merge facts without prose inference.
- Worker and reviewer provider dimensions remain separate in RPC results.
- Historical gaps are partial and excluded from denominators that require the
  missing edge.
- Cohort, scope, provider, profile and time filters use the shared snapshot
  from Spec 009 and remain responsive.
- UI labels rates as signals and exposes underlying counts.
- Tests prove attribution across unchanged and changed heads, multiple review
  rounds, pre-merge refusal and unrelated operational incidents.

## Exclusions

No provider-weight change, quality ranking, global shadow-review enablement,
extra reviewer dispatch, repository-prose classification or live-task mutation
belongs to this work.
