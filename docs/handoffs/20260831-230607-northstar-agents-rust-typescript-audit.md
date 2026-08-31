---
title: Nucleus Northstar AGENTS, Rust, and TypeScript audit worker handoff
kind: northstar-handoff
handoff_mode: worker-pr-loop
worker_mode: implementation
dispatch_authority: orchestrator
handoff: single-file-path-only
status: ready-to-launch
owner: Tom / Northstar orchestrator
created: 2026-08-31
updated: 2026-08-31
handoff_path: /Users/tom/Dev/projects/nucleus/docs/handoffs/20260831-230607-northstar-agents-rust-typescript-audit.md
base_required: pushed-main
tags: [coordination, handoff, worker, pr, audit, rust, typescript]
---

## What This Thread Was Doing

The operator is auditing projects one at a time. Nucleus is the second lane:
one target-aware AGENTS review plus repository-scope Rust and desktop
TypeScript/Svelte audit-and-repair, delivered as one worker PR for orchestrator
review.

Planning resolved the only missing compatibility choice. Nucleus now has
operator authority to declare Rust 1.95, matching Longhorn's floor. No
transcript or second prompt is part of this dispatch.

## Why It Matters

Nucleus has 19 Rust packages, a 431-file desktop TypeScript/Svelte surface, and
strict product boundaries around persistence, credentials, host authority, and
generated control DTOs. This pass should improve quality without turning broad
scan leads into an architecture rewrite or making TypeScript the durable
authority.

## Current State

- **Repository:** `/Users/tom/Dev/projects/nucleus`
- **Planning branch:** `main`
- **Planning base commit:** `b8dba3233b1d40cfe865960147f621d9f0a80846`
- **Pushed main verification:** local `HEAD == origin/main` at that commit before
  this handoff was created
- **Planning checkout:** clean after the planning commit
- **Worker mode:** implementation worker dispatched by the orchestrator; this
  handoff activates the worker-only preflight
- **Planning artifacts:** g05 roadmap 026, card 108, and the opening log
- **Worker branch:** `worker/northstar-agents-rust-typescript-audit`
- **Worker worktree:** Paseo-managed branch-off worktree; its actual clean
  non-`main` path and branch are authoritative
- **Worktree creation:** Paseo `branch-off` from pushed `origin/main`
- **Required sibling worktree link:** `longhorn` ->
  `/Users/tom/Dev/projects/longhorn`, available as `../longhorn` from this
  worktree. The orchestrator creates/verifies it before launch. Reuse only that
  exact symlink; stop on a missing source or conflicting destination.
- **Active spec lane:** none; this is promoted maintenance work
- **Roadmap milestone:**
  `docs/roadmaps/g05/026-northstar-instruction-and-language-quality-audit.md`
- **Ready card:**
  `docs/roadmaps/g05/batch-cards/108-northstar-agents-rust-typescript-audit.md`
- **Allowed runway:** card 108 only
- **Remaining card budget:** one card, one PR
- **Dispatch topology:** serial combined audit; Rust-generated bindings,
  TypeScript consumers, and instructions share review boundaries
- **Canonical refs:** system architecture, product guardrails, repository
  authority map, working rules, and agent-instruction contract named by card 108
- **Review oracle:** roadmap 026 `## Review Oracle`
- **Model capability profile:** high-reasoning frontier worker; security,
  persistence, concurrency, public API, and cross-language boundaries are in
  scope for assessment
- **Tool/runtime restrictions:** dependencies are bootstrapped before launch;
  do not install or upgrade dependencies. Do not run native GUI proof, release
  mutations, or edit CI/workflows.
- **Required validation:** recorder-selected focused evidence, `effigy qa`,
  `effigy qa:docs`, installed Northstar instruction checker, and
  `git diff --check`
- **PR base/head:** `main` <- worker branch above
- **PR URL:** pending
- **Review state:** awaiting worker PR
- **Merge path:** orchestrator after accepted exact-head review and passing
  required checks; the worker does not merge

## Boundaries

- **In scope:** every ordered step and acceptance item in card 108.
- **Out of scope:** g06 selection, the orchestration product checkpoint,
  deferred product lanes, native GUI proof, broad god-file splitting,
  dependency/toolchain migration, CI/workflow changes, release work, and
  architecture replacement.
- **Outcome shape:** audit-and-repair. Record findings before mutation and make
  only the smallest recorder-authorized repairs.
- The approved compatibility change is exactly Rust 1.95 at the workspace and
  inheritance by its members. Do not choose another version policy.
- Generated desktop control bindings are generator-owned read-only output.
  Give them an explicit disposition and inspect the generator/boundary; never
  hand-edit them.
- Stop before changing a public API, persistence/security/concurrency/error/
  serialization contract, retry policy, or visible product behavior that card
  108 does not already settle.
- Preserve report-only, operator-decision, retained, generated, read-only,
  excluded, and unrelated files byte-for-byte.
- Work only in the launcher-selected clean worktree. Never clean, reset, stash,
  or edit the primary planning checkout.
- Do not merge or start a nested worker/orchestrator lane.

## Important Context

- Northstar Rust and TypeScript activation/profile/deviation files are absent.
  Install them through the installed skill as card 108 directs before recorder
  initialization. The setup and approved MSRV tranche may precede recorder
  initialization; no audit-owned source repair may.
- Root `CLAUDE.md` is already exactly `@AGENTS.md`. The initial instruction
  measurement is 69 non-blank lines, about 864 tokens, with five placement,
  three procedure, and two freshness leads. Mechanical leads are not prose
  verdicts.
- Root AGENTS still names T3-specific worktree layout. Determine the durable
  sibling requirement from current contracts and Paseo operation; do not
  delete the safety boundary merely because one harness name is stale.
- Svelte is 5.56.8. No SvelteKit package evidence was found.
- `effigy doctor` starts degraded: two Bun registrations without ledger, 293
  god-file findings (13 errors), 302 generated-in-source warnings, and a stale
  graph. These are baseline limitations, not blanket repair authority.
- The prior July codebase audit is historical evidence, not current finding or
  repair authority. Reassess current code under the strict catalogues.
- **Report after:** setup/recorder initialization; each completed language
  audit; instruction optimization; final PR.
- **Report to:** the orchestrator through the active Paseo agent.

## Suggested Next Move

Run the worker preflight before broad reads. Accept the clean launcher worktree,
verify this handoff from its selected `HEAD`, and verify `../longhorn` resolves
to the primary Longhorn checkout. Then read roadmap 026, card 108, AGENTS, and
their canonical refs. Start with the approved MSRV and quality-activation
setup, freeze both scopes, and initialize each recorder before its source
assessment or repair.

## Completion Protocol

### Before you start

1. This handoff's worker metadata activates worker mode. Before broad reads,
   run `git rev-parse --show-toplevel`, `git branch --show-current`,
   `git status --porcelain`, and `git worktree list --porcelain`.
2. Use the current worktree when it is clean, registered, and non-`main`. Its
   actual path/branch outrank the planned names. Do not create another.
3. If the launcher context is dirty, `main`, unregistered, or unusable, stop
   and report it. Do not create a hidden fallback behind Paseo.
4. Fetch with a bounded non-interactive SSH command. Confirm `HEAD ==
   origin/main`, confirm planning base `b8dba3233b1d40cfe865960147f621d9f0a80846`
   is an ancestor, and confirm this repository-relative handoff exists in
   `HEAD`. Load it with `git show HEAD:docs/handoffs/20260831-230607-northstar-agents-rust-typescript-audit.md`.
   If it differs from the absolute dispatch file, stop. The tracked blob is
   canonical.
5. Verify `../longhorn` is a symlink resolving exactly to
   `/Users/tom/Dev/projects/longhorn`. Stop on absence, mismatch, directory, or
   file. Never delete, replace, or overwrite it.
6. Read the card, roadmap, AGENTS chain, and canonical refs. Use Effigy for
   repository-owned task routing and record what actually ran.

### While you work

- Execute card 108 in order. Initialize each recorder before any source repair
  it owns and keep units disjoint.
- Treat one assessed unit as one coherent wave. Extend recorder ownership before
  touching a caller, test, doc, or contract outside the unit.
- Report each meaningful chunk with changed files, evidence, remaining scope,
  retained findings, and blockers.
- Return a new product threshold, compatibility rule, or contract choice to the
  orchestrator instead of choosing it.
- Record small recurring execution friction in `PAPERCUTS.md` only when the
  working-rules contract calls for it; do not turn it into unplanned repair.

### When card 108 is complete

1. Run the required validation named in card 108. Unavailable or warning-bearing
   evidence stays unavailable/warning; it is never rewritten as a pass.
2. Falsify the diff against every roadmap-oracle row and reconcile the Rust
   report, TypeScript result, card, roadmap, logs, handoff, AGENTS chain, and
   front-door state.
3. Update the card, roadmap 026, opening log, g05 indexes/currentness, and one
   closeout log with actual findings, repairs, evidence, and limitations.
4. Push the worker branch and open one reviewable PR against current `main`.
5. The PR body links the roadmap, card, both recorder results, instruction
   section map, changed surfaces, validation, and every unresolved item.
6. Report the exact head and PR URL through Paseo. Do not merge.

### Review and merge path

The orchestrator reviews the exact PR head against roadmap 026, card 108,
contracts, recorders, diff, and checks. A provider comment is the canonical
verdict when formal self-approval is unavailable. If changes are requested,
stay on this branch and address only the posted in-bounds findings after Paseo
wakes you. A planning change returns to the orchestrator first.

Accepted current-head work with passing checks and clear mergeability may be
merged by the orchestrator without another operator prompt.

- **Closeout refs:** card 108; roadmap 026; opening and closeout logs;
  `docs/roadmaps/README.md`; `docs/README.md`; this handoff

### Handoff closeout

Leave one honest state: complete with a PR, or blocked with the precise missing
authority, scope, or validation result. Do not make the lane look complete when
either recorder, the instruction review, or the cross-surface reconciliation is
unfinished.
