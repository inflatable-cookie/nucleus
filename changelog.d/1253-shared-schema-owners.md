The shared schema modules now have one owner per mechanism. Review's submission,
completion, evidence, proof execution, acceptance, checkpoints and review entry
sit in `shared/schema/review/`, settings' scales, usage, routing, pool, limits and
legacy renames in `shared/schema/settings/`, and the retired submission controls
with their one refusal rule in `review/retired-submission.ts`, so intake, the task
funnel, brief frontmatter, brief amendment and review entry refuse a retired
control with the same owner's words.

A pool entry's cost scale is derived from the capability scale, a settings limit
is bounded and defaulted once for the settings write and the board state, and the
retained-worker profile park is one shared fact read by `isRetainedProfileReason`
instead of five text matches. Profile, board-event and availability records now
refuse a field their contract does not declare rather than dropping it.
