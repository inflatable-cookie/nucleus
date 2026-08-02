# 028 Retained Adapter Decomposition

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../009-longhorn-secondary-system-admission.md`
Depends on: card 027
Auto-start next card: yes

## Objective

Split retained Longhorn migration adapters into focused Nucleus-owned policy,
host, persistence, and renderer modules without changing behavior.

## Acceptance

- [x] split the admitted oversized migration adapters along named domain boundaries
- [x] keep product policy and durable state ownership in Nucleus
- [x] preserve storage, window, layout, and Browser behavior
- [x] prevent later Longhorn work from accumulating in catch-all adapters

## Validation

- [x] focused Rust and desktop fixture selectors pass
- [x] Doctor findings improve or remain explicitly baselined

## Stop Conditions

- stop on unplanned schema, behavior, or authority changes
- do not absorb unrelated oversized-file debt into this card

## Evidence

- `storage_migration.rs` is now a 343-code-line coordinator over separate
  SQLite, tree, and split-UI adapters plus external tests
- `desktop_profile.rs` now separates host discovery, input validation, and tests
- `workspace_ui/runtime.rs` now separates project-document mechanics from the
  runtime session
- Doctor error findings fell from 28 to 26; `storage_migration.rs` and
  `desktop_profile.rs` left the error class
- all 56 `nucleus-desktop` Rust tests passed
