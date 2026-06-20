# 124 Health And Runway Rebaseline

Status: completed
Owner: Tom
Updated: 2026-06-20

## Purpose

Reduce the structural drift found in the 2026-06-20 stocktake before more SCM
adapter-specific work is added.

The previous SCM capture and change-request preparation lane is architecturally
sound, but it expanded request-handler, control DTO, and SCM persistence test
surfaces enough that `effigy doctor` now reports red god-file pressure. This
lane is a bounded reset, not a product pivot.

## Governing Refs

- `docs/logs/2026-06-20-stocktake.md`
- `docs/architecture/implementation-gap-index.md`
- `docs/roadmaps/g02/123-scm-change-request-adapter-plan-selection.md`
- `docs/contracts/001-working-rules.md`

## Goals

- [x] Split the largest request-handler diagnostics test surface into smaller
  domain files.
- [x] Split the largest control-envelope diagnostics test surface into smaller
  domain files.
- [x] Split request-handler query routing enough that new diagnostics domains
  do not keep collecting in one module.
- [x] Reduce or isolate the largest new SCM review/prep modules when touched.
- [x] Re-run health checks and decide whether roadmap 123 can resume.
- [x] Split the SCM diagnostics request-handler test submodule created by the
  first pass.
- [x] Split control-envelope request DTO tests that remain an error-sized
  finding.
- [x] Select or defer the next durable dispatch/provider split targets.
- [x] Split embedded tests from the top durable dispatch/provider error files.
- [x] Re-run health checks and resume roadmap 123 with remaining broad
  god-file debt tracked separately.

## Execution Plan

- [x] Request-handler diagnostics test split.
- [x] Control-envelope diagnostics test split.
- [x] Request-handler query module split.
- [x] SCM review/prep module split or documented deferral.
- [x] First health rebaseline closeout and roadmap 123 pause decision.
- [x] Request-handler SCM diagnostics test split.
- [x] Control-envelope request test split.
- [x] Durable dispatch/provider split target selection.
- [x] Durable executor dispatch outcome linkage test split.
- [x] Durable dispatch outcome persistence test split.
- [x] Git dry-run execution persistence test split.
- [x] Second health rebaseline closeout and roadmap 123 resume decision.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/584-request-handler-diagnostics-test-split.md`
- `batch-cards/585-control-envelope-diagnostics-test-split.md`
- `batch-cards/586-request-handler-query-module-split.md`
- `batch-cards/587-scm-review-prep-module-split.md`
- `batch-cards/588-health-rebaseline-closeout.md`
- `batch-cards/589-request-handler-scm-diagnostics-test-split.md`
- `batch-cards/590-control-envelope-request-test-split.md`
- `batch-cards/591-durable-dispatch-god-file-target-selection.md`
- `batch-cards/593-durable-dispatch-outcome-linkage-test-split.md`
- `batch-cards/594-durable-dispatch-outcome-persistence-test-split.md`
- `batch-cards/595-git-dry-run-execution-persistence-test-split.md`
- `batch-cards/592-health-rebaseline-second-closeout.md`

## Acceptance Criteria

- [x] The highest-pressure request-handler diagnostics tests are moved into
  focused files without behavior changes.
- [x] The highest-pressure control-envelope diagnostics tests are moved into
  focused files without behavior changes.
- [x] Query routing ownership is clearer before adding adapter-plan diagnostics.
- [x] `effigy doctor` god-file findings are materially reduced or remaining
  errors are explicitly accepted as follow-on work.
- [x] The next active lane is either resumed roadmap 123 or a clearly recorded
  additional health gate.
