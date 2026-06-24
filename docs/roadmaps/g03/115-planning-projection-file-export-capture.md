# 115 Planning Projection File Export Capture

Status: active
Owner: Tom
Updated: 2026-06-24

## Purpose

Write reviewed planning artifact and task seed projection payloads to scoped
management projection files, then prepare management-capture evidence without
importing, applying, committing, pushing, publishing, or calling provider
effects.

Roadmap `114` proved concrete planning projection payloads, deterministic refs,
codec coverage, read-only export planning, and read-only diagnostics. The next
gap is the file export boundary: converting export entries into deterministic
`nucleus/` projection files under explicit policy.

## Governing Refs

- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/architecture/planning-management-projection-shape.md`
- `docs/roadmaps/g03/114-planning-management-projection-payloads.md`

## Goals

- [ ] Select the first planning projection file-write boundary.
- [ ] Write planning projection TOML documents under scoped `nucleus/` paths.
- [ ] Preserve deterministic output and controlled blocked records.
- [ ] Prepare management-capture evidence without creating commits or shares.
- [ ] Keep import/admission, merge policy, SCM mutation, forge mutation, task
  promotion, provider execution, and UI out of scope.

## Execution Plan

- [ ] Batch 1: select file-write boundary, authority, and blocked paths.
- [ ] Batch 2: implement deterministic planning projection file document
  materialization without import/apply.
- [ ] Batch 3: add write diagnostics and no-effect evidence.
- [ ] Batch 4: connect planning projection files to management-capture prep
  records without SCM publication.
- [ ] Batch 5: validate and choose import/admission, capture publication, or
  planning-session depth as the next lane.

## Batch Cards

Ready cards:

- `batch-cards/483-planning-projection-file-write-boundary-selection.md`

Planned cards:

- `batch-cards/484-planning-projection-file-document-materialization.md`
- `batch-cards/485-planning-projection-file-write-diagnostics.md`
- `batch-cards/486-planning-projection-capture-prep-records.md`
- `batch-cards/487-planning-projection-cli-effigy-inspection.md`
- `batch-cards/488-planning-projection-file-export-validation.md`
- `batch-cards/489-planning-projection-next-lane-checkpoint.md`

Completed cards:

- None yet.

## Acceptance Criteria

- [ ] Planning projection files are written only under `nucleus/planning/` and
  `nucleus/planning/task-seeds/`.
- [ ] Invalid refs and unsupported records are surfaced as controlled issues.
- [ ] No projection import, active planning mutation, task promotion, SCM/forge
  mutation, provider execution, or UI behavior is added.
- [ ] Capture prep cites file refs and sanitized evidence only.

## Stop Conditions

- The work requires applying projection files as active planning authority.
- The work requires resolving multi-user semantic merge conflicts.
- The work requires creating commits, pushing, publishing, or opening forge
  review boundaries.
- The work requires provider execution, raw payload retention, or UI behavior.
