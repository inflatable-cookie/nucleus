# 037 — Structured review findings

Status: retired (Spec 058 cutover 2, Tom, 2026-11-02); structured verdicts stay as ordinary reviewer evidence
Owner: Queue runtime maintainers
Decision owner: Tom (2026-10-07, remove automatic review loops)
Governing refs: [Spec 033](../033-formal-pr-reviews.md), [Spec 036](../036-role-reassignment.md), [Spec 058](../058-responsible-tasks.md) (cutover)

## Retirement

Spec 058's cutover removed the brief-declared `reviewVerdicts` and
`reviewPassGate` frontmatter (2026-11-02). A brief states its outcome and
acceptance in prose, and a planner who needs a hold uses `queue.mergeHold` with
a reason. New submissions carrying the retired keys are refused with the
replacement named; stored rows and frozen submission identities keep parsing,
and the optional persisted fields stay readable. The retained reviewer judges
the change and reports ordinary structured verdicts when it has them; the
verdict list, its immutable records, its bounded shape and the worker-citation
equality check remain the surviving contract below. The manual verification
coordinator was deleted in the same batch.

## Current contract

A review may carry optional bounded structured findings (`verdicts`): stable
`id`, `subject`, `verdict` (`pass`, `fail`, `insufficient`, `not_applicable`),
actual `evidence`, and optional `note`. Records retain the authentic reviewer,
run, exact head and published review identity. They are immutable evidence,
never a separate execution plan or permission to publish or sign. The records
and the task's current review are stored outside the task row, in their own
table (schema 44, Tom 2026-10-21), so an ordinary task update never rewrites
them.

Stored briefs with `reviewVerdicts` or `reviewPassGate` remain readable, but
those fields impose no review or pass gate. Published values must match the
immutable review they actually cite.

Tom authorised the papercut work sequence on 2026-10-23 ("Go for it"), starting
with truthful evidence handling. A reviewer whose source assessment is complete
but blocked by external or owner-gated evidence may report `blocked` or `error`
with `reviewResponsibility: environment`, full bounded `reviewText` and structured
findings. The authenticated completion retains the run and exact head; after
release it becomes the current blocked review evidence, before any notification
hook can hold that transition. A holding hook cannot leave an older approval
current instead. Prior accepted-verdict
history is unchanged, and the blocked findings remain on their original run.
They are not published as a review, grant no
approval, and do not start an author revision. An explicit owner disposition or
ordinary supported continuation is still needed. This uses existing completion
and current-review fields; public and persisted schemas are unchanged.

`changes_required` with a concrete author defect uses the ordinary bounded
revision budget. There is no budget-free pass-gate/publication continuation.
The legacy `reviewContinuationIds` field remains parseable for old briefs but
has no execution effect. Old pending publication continuations park until an
explicit operator revision supplies the authorized correction; releasing a
hold or unpausing Queue does not authorize them.

Unfinished reviewer coverage is not an author defect. It may be saved as
progress under [Spec 044](044-reviewer-checkpoint-continuation.md), without a verdict or
an automatic turn. The bounded operator-only continuation in Spec 044 preserves
the same run and checkpoint; it adds no verdict, pass, pass-gate credit or
approval. Source, rights, personal reading, independent review and exact-head
approval remain required. Issuing and signing stay with the consumer's
registered producers.
