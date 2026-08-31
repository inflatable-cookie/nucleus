# 108 Northstar AGENTS, Rust, And TypeScript Audit

Status: ready
Owner: Tom
Created: 2026-08-31
Roadmap: `../026-northstar-instruction-and-language-quality-audit.md`
Auto-start next card: no

## Objective

Run one repository-scope Northstar AGENTS review and explicit Rust and
TypeScript/Svelte audit-and-repair pass. Finish with deterministic records,
bounded repairs, honest retained findings, closeout evidence, and one PR for
orchestrator review.

## Operator Decision

Rust 1.95 is the repository MSRV. It matches the committed Longhorn dependency
floor and is the narrowest coherent whole-workspace policy.

This card authorizes:

- `rust-version = "1.95"` under `[workspace.package]`
- `rust-version.workspace = true` in each workspace package that needs the
  inheritance declaration

No other compiler, edition, dependency, or version-support policy change is
authorized.

## Governing Refs

- `../026-northstar-instruction-and-language-quality-audit.md`
- `../../../contracts/001-working-rules.md`
- `../../../contracts/034-agent-instruction-surface-contract.md`
- `../../../architecture/system-architecture.md`
- `../../../architecture/product-guardrails.md`
- `../../../architecture/repository-authority-map.md`
- the installed Northstar explicit Rust, TypeScript/Svelte, AGENTS review, and
  recorder contracts

## Ordered Work

### 1. Freeze baseline and install policy

- preserve all pre-existing dirty state; the dispatched worker starts from a
  clean dedicated worktree
- capture Cargo/package/target/feature and desktop package/source inventories
- add the approved Rust 1.95 workspace policy
- install missing Rust activation/profile/deviations at repository scope
- install missing TypeScript activation/profile/deviations for
  `apps/desktop`
- resolve the TypeScript base and Svelte 5 overlays; do not apply SvelteKit
  without package evidence
- give generated bindings, ignored/vendored material, and every dirty file an
  explicit owned, read-only, or excluded disposition

The setup and approved version-policy tranche may precede recorder
initialization. No audit-owned source repair may.

### 2. Rust repository audit

- use repository scope and the verified Northstar Rust payload plus pinned
  scanner
- cover the workspace root and all 19 packages, every discovered target and
  feature, public API surfaces, unsafe/FFI, async, persistence, concurrency,
  process, credential, serialization, and host/client boundaries
- partition disjoint assessed units, initialize the recorder, then run separate
  correctness, architecture, and human-quality passes for every unit
- maintain a total exact-forwarder candidate ledger
- record every finding before mutation; repair only bounded
  `review_required` plans and extend ownership before touching callers, tests,
  docs, or contracts outside a unit
- leave report-only, operator-decision, retained, excluded, and unaffected
  units byte-identical

### 3. TypeScript and Svelte repository audit

- use repository scope for the owned `apps/desktop` package
- initialize the TypeScript recorder before source mutation and partition
  hand-written source/config/test ownership into disjoint units
- treat `src/lib/control/generated/` and other proven generated outputs as
  generator-owned read-only material; audit the generator/boundary rather than
  editing output by hand
- assess type evidence, external boundary narrowing, async lifecycle, error
  observability, package/import direction, Svelte reactive ownership,
  accessibility, and the complete evaluation-only slop ledger
- record before repair and preserve every reported, operator-decision,
  generated, read-only, or excluded file

### 4. AGENTS and Claude review

- run the installed target-aware instruction checker before and after
- read the whole applicable instruction chain plus the project, architecture,
  task, and working-rules surfaces it protects
- build a section-intent map and review the file as one unfamiliar-reader
  journey
- preserve every authority, stop, release, worktree, sibling-link, validation,
  papercut, and language-quality activation boundary
- keep root `CLAUDE.md` exactly `@AGENTS.md`
- optimize only the instruction surfaces and their evidence; do not impose a
  Northstar house outline or optimize for line count alone

### 5. Reconcile and close

- finalize both recorders and link their exact reports/results from the PR
- distinguish repaired findings, retained findings, operator decisions,
  out-of-catalogue defects, unavailable evidence, and pre-existing doctor
  findings
- update this card, roadmap 026, the opening log, g05/front-door currentness,
  and one closeout log
- falsify every universal, exact, and negative claim against the roadmap review
  oracle before opening the PR

## Acceptance

- [ ] Rust 1.95 resolves as the effective MSRV for every Cargo package; no
  wider version policy changed
- [ ] Rust activation, strict profile, and deviations record are valid
- [ ] TypeScript activation, strict profile, deviations record, and Svelte 5
  overlay resolution are valid
- [ ] complete Rust and TypeScript recorder results reconcile every unit,
  finding, repair plan, evidence record, mutation, exclusion, and limitation
- [ ] no report-only, operator-decision, generated, read-only, excluded, or
  unrelated file changed
- [ ] repairs preserve public API, persistence, security, concurrency,
  serialization, host/client authority, and visible product behavior
- [ ] AGENTS has an evidence-backed reader journey, all hard boundaries remain,
  and `CLAUDE.md` is the exact bridge
- [ ] baseline doctor degradation is reported honestly and not treated as
  blanket repair authority
- [ ] one reviewable PR targets `main`; the worker does not merge

## Validation

- recorder-selected focused compiler, lint, docs, test, framework, and scanner
  evidence with actual environment/status/warnings
- `effigy qa`
- `effigy qa:docs`
- installed Northstar target instruction checker
- `git diff --check`

Do not run native GUI proof. Record any selector that cannot start or collect
as unavailable rather than substituting a pass.

## Stop Conditions

- Rust 1.95 cannot be made the effective workspace policy without another
  compatibility choice
- package/overlay/generated ownership cannot be resolved honestly
- a repair needs a public API, persistence, security, concurrency, error,
  serialization, retry, or product behavior decision
- a required recorder cannot initialize or scope cannot be partitioned without
  overlap or hidden mutation
- validation failure changes the plan rather than identifying an in-scope
  repair

