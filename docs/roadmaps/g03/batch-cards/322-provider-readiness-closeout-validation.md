# 322 Provider Readiness Closeout Validation

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../085-provider-readiness-product-closeout-and-next-lane-selection.md`

## Purpose

Validate the closeout and next-lane selection docs.

## Acceptance Criteria

- [x] Docs QA passes.
- [x] Northstar QA passes.
- [x] Doctor remains error-free.
- [x] Single `## Next Task` pointer remains in `docs/roadmaps/README.md`.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `effigy doctor`
- `rg "^## Next Task" -n README.md AGENTS.md docs -g '*.md'`
