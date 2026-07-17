# Codebase Audit Findings

Date: 2026-07-17
Lane: cross-cutting audit before next hardening band

## Outcome

Full workspace audit (architecture, persistence, server/CLI, desktop, domain
crates, tests/docs) produced ranked findings now compiled into g04 milestones
042-048.

Critical:

- read-only command execution enforces nothing: sandbox/env policy enums are
  stamped into evidence but never consulted at spawn
  (`crates/nucleus-server/src/local_read_only_spawn/spawn.rs`); the shell
  denylist passes `python -c`, `rm -rf`; `--confirm-real-write` fabricates
  operator-confirmation evidence from a bare flag
- optimistic concurrency races: revision check and upsert run without a
  transaction on per-operation connections
  (`crates/nucleus-local-store/src/sqlite.rs`)
- event replay order is lexicographic over command-id-derived event ids; no
  monotonic sequence exists

High:

- engine-first is inverted: nucleus-server holds ~214k lines (~87% of code);
  contract 022's migration list was never executed; nucleusd imports server in
  87 files, engine in 1
- provider admission features are a 5-file template stamped ~350 times; 1,538
  `executed: false` literals; ~100 bespoke `NoEffects` structs
- nucleus-agent-adapters and nucleus-contract-fixtures are orphan crates; Codex
  is hardcoded into the server; no Claude adapter exists
- desktop control envelope contract is hand-duplicated (Rust 56 variants, TS
  ~25) with no codegen and no runtime validation; CSP disabled; frontend tests
  exist but nothing runs them; no CI anywhere
- ~25-30% of tests are tautological (render-grep, constant assertions);
  nucleus-local-store has near-zero direct tests
- docs/roadmaps holds 2,019 files of generation/batch-card residue (94% of
  docs volume)

## Evidence

- six independent audit passes over crates, apps, docs, and tests with
  file-level citations recorded in the g04 milestone files
- counts verified by grep: `executed: false` x1538, 530 server modules, 196
  `Control*Dto`, 2,140 docs files (2,019 under roadmaps)

## Next

Execute milestones in order: 042 execution-safety honesty, 043 CI runway,
044 persistence correctness, then consolidation and boundary migration
(045-046), desktop contract integrity (047), roadmap archive (048).
