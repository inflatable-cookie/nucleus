# 322 Provider Readiness Closeout Validation

Status: ready
Owner: Tom
Updated: 2026-06-22
Milestone: `../085-provider-readiness-product-closeout-and-next-lane-selection.md`

## Purpose

Validate the closeout and next-lane selection docs.

## Acceptance Criteria

- [ ] Docs QA passes.
- [ ] Northstar QA passes.
- [ ] Doctor remains error-free.
- [ ] Single `## Next Task` pointer remains in `docs/roadmaps/README.md`.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `effigy doctor`
- `rg "^## Next Task" -n README.md AGENTS.md docs -g '*.md'`
