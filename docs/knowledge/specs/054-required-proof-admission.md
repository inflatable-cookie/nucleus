# 054 — Required proof when a repository overrides validation policy

Status: implemented

> 2026-11-09 (task 985): the per-repository validation policy — the override
> this spec's incident turned on — is retired (Tom). The repository's
> `AGENTS.md` Validate section is the only source, prompts carry one fixed line
> instead of injected policy text, and the required-proof rule is fixed Nucleus
> text no repository content can edit. The incident narrative below stays as
> history; policy-rendering examples describe the retired implementation. The
> gate matrix names the current owners of the surviving controls.
Owner: Nucleus runtime maintainers
Created: 2026-10-24
Decision owner: operator (Tom). Promoting papercut `1b003af5-4bea-4c7f-84fa-25719db66429`
was tracking, not a ruling on the policy below. The later operator ruling is
recorded here.
Governing refs: [Spec 037](retired/037-structured-review-verdicts.md)
(retired 2026-11-02; verdicts remain ordinary reviewer evidence),
[Spec 040](040-merge-hold-release-prompts.md) and
[Spec 046](046-self-lifting-merge-holds.md) (holds),
[Spec 018](018-queue-owned-closeout-and-durable-outcomes.md) (immutable
outcomes), [orchestration contract](../contracts/orchestration.md) (validation
rule), [Spec 033](033-formal-pr-reviews.md) (review identity).

The fixed prompt instruction renders outside the repository's policy text. It is
prose guidance only: no schema, setting, refusal code, proof field or control
follows from it. [Spec 058 cutover 2](058-responsible-tasks.md) (2026-11-02)
retired the structured brief keys: `queue.reviewVerdicts` and
`queue.reviewPassGate` are refused at submission and `amend_brief` with the
replacement named — the outcome and acceptance belong in the brief's prose, and
a needed hold uses `queue.mergeHold`. The retained reviewer judges a named
proof and reports the ordinary structured verdicts; recorded verdicts and their
immutable records remain (Spec 037, retired). Stored rows keep parsing.

## Spec 058 cutover 2 (2026-11-02)

- The brief frontmatter keys `reviewVerdicts` and `reviewPassGate` (and
  `manualVerification`) are refused at submission, review entry and
  `amend_brief` with a message naming the replacement: state the outcome and
  acceptance in prose, and use `queue.mergeHold` for a needed hold.
- The report-time refusals (`assertReviewPassGate`, the opt-in verdict gate)
  and the stale-gate return to review (`refuseStaleReviewPassGate`,
  `review_pass_gate_refused`) are deleted. `assertReviewResponsibility` keeps
  the reviewer responsibility and reviewer-only verdict shape checks.
- A named required proof is now enforced by the retained reviewer's judgment
  and recorded in its verdicts and prose; the merge gates (exact head, review
  evidence, mechanical checks) and `queue.mergeHold` stay the mechanical
  controls.

## Problem

Retained evidence from `project-c#131` (task `6e9f661a-1b69-4d97-9d6a-298fe51500a8`,
PR 125, reviewed head `f84684e0cc23725be9ad48c604f854d82423b815`, merge
`a66e7dddc4c0e680504625891b6af8efff8a28c7`, outcome `done`) records four things
at once:

- the brief's `## Acceptance` names "ONE fixed author native" proof, in prose;
- the brief's queue frontmatter carries only `dependsOn`, `lane`, `complexity`
  and `siblings: false` — no `mergeHold`, no `reviewVerdicts`, no
  `reviewPassGate`;
- the reviewer approved at the exact head with full reviewText that says "The
  native wrapper proof is not run here and gets no native credit", after
  reporting `docs:check` and a synthetic 9/9 suite;
- `ownerAcceptance` and `reportAcceptance` are both null on the outcome.

The merge was admitted by ordinary gates. No gate malfunctioned. What was
missing is a decision about **which sentence governs** when a brief names a
required proof and the repository's `validationPolicy` (revision 115 for
`inflatable-cookie/project-c`) says, in its own prose:

> STANDARD default: author runs covering compile/format as applicable,
> unit/regression tests, docs checks for changed docs, and focused native proof.
> … Report missing/insufficient evidence honestly. … Preserve findings/missing
> evidence and merge/close without publication-only review loop.

So the override did not delete the proof requirement. It supplied a *different
consequence* for a missing proof than the default policy supplies, and nothing
in Nucleus compares the two.

## Historical instruction layers

The following layers describe the historical rendering and retired structured
admission subjects. Historical symbols below are not current source locations;
the gate matrix and delivered-implementation section name the current owners.

1. **The validation-policy block.** `operatorValidationBlock` (the historical policy renderer)
   renders a fixed heading plus `effectiveValidationPolicy(policy, null)`
   verbatim into every worker, revision, reviewer, coordinator and closeout
   prompt. The verification coordinator role is retired. The repository row wins over the host default, and
   known retired seeds are re-rendered as the current default
   (the historical `effectiveValidationPolicy` mapping). The engine worker prompt
   and adapter run-creation path read it.
2. **The reviewer's own proof rule.** A fixed sentence, outside the policy text,
   says a brief-assigned *reviewer* proof must be performed by that reviewer or
   reported `blocked` in the historical reviewer prompt. It is scoped to reviewer-assigned
   proof and says nothing about an author proof the reviewer is assessing.
3. **Structured admission subjects (retired).** `queue.reviewVerdicts` and
   `queue.reviewPassGate` used to name verdict ids a reviewer report must carry
   or pass. Spec 058 cutover 2 refuses both keys at intake; reviewer verdicts
   remain optional ordinary evidence (`shared/contracts.ts`, retained optional
   task fields for stored rows).
4. **The required-proof instruction (delivered, Queue #400).**
   `REQUIRED_PROOF_AUTHOR_NOTE` and `REQUIRED_PROOF_REVIEWER_NOTE`
   render through `requiredProofNote` outside
   the policy block: the author note in the worker, worker checkpoint
   continuation and revision prompts, and the reviewer note in the reviewer and
   reviewer-continuation prompts. The repository policy text is still rendered
   verbatim beside them. This layer is prose: it refuses nothing and infers
   nothing from headings or prose.

The only place the sentence "Missing required proof is a blocker, not permission
to report approval" appears in code is **inside** `DEFAULT_VALIDATION_POLICY`
(the retired default-policy constant). A repository override is rendered instead of that
constant, so a custom override carries that consequence only if it happens to
repeat it. That is why the delivered instruction in layer 4 sits outside the
block: it survives an override that contradicts or omits the default's
missing-proof consequence. There is no author-side proof field at all:
`completionBaseSchema` (now in `shared/schema/review.ts`) has no place to declare
proof, and `reviewedInputs` is reviewer-side.

## Gate matrix

Current controls are located by owner and symbol, so source moves do not leave
stale line numbers. The first two rows retain the retired rendering's limits.

| Gate | Source | Fires on | Refuses with | Blind spot |
| --- | --- | --- | --- | --- |
| Validation-policy override prose (retired) | Historical `operatorValidationBlock` and `effectiveValidationPolicy`; current fixed authority text is `VALIDATION_AUTHORITY_RULE` in `core/dispatch/prompts.ts` | every run | nothing — prose only | the retired override could omit or contradict the default's missing-proof consequence |
| Reviewer-assigned proof (historical rendering) | Historical reviewer prompt; current proof instructions are `REQUIRED_PROOF_REVIEWER_NOTE` in `core/dispatch/prompts.ts` | reviewer prompt | nothing — prose only | the historical sentence covered the reviewer's own proof, not author evidence |
| Retired brief gates | `refuseRetiredQueueFlags` in `core/planning/handoff.ts`; `Store.insert` in `core/store/store.ts`; amendment parsing in `core/verbs/brief.ts` | submission, review entry or `amend_brief` carrying `reviewVerdicts`/`reviewPassGate` | a refusal naming the prose acceptance and merge-hold replacement | none — a prose acceptance is judged by the retained reviewer (Spec 058 cutover 2) |
| Accepted review present | `MergeGates.advanceMerging` and `verification` in `core/merge/merge-gates.ts` | merge turn | `Current independent review is required`; `Accepted exact-head review evidence is missing` | an exact-head operator source acceptance may stand in |
| Exact-head identity | `completionRefusal` in `core/intake/callback-intake.ts`; `MergeGates.verification` in `core/merge/merge-gates.ts` | non-blocked reviewer report; merge turn | `Result must name the requested exact head`; `Head changed after review` | none — it is the anchor every other gate trusts |
| Merge hold | `mergeFenced` in `shared/holds.ts`; `MergeGates.requestMerge` in `core/merge/merge-gates.ts`; Spec 040 | merge turn | the held wait from `mergeFenceReason` in `core/recovery/task-reasons.ts` | independent of verdicts; a held task still reviews |
| Owner acceptance | `MoveControls.moveToMerge` in `core/verbs/moves.ts`; `operatorSourceAcceptance` in `shared/task-view.ts` | `move to=merge` | records accepted risk (`operator_source`) or binds the authentic review (`reviewed`) | it mints no `pass` and does not clear a failing gate |
| Terminal outcome | `StoreOutcomes.putOutcome` in `core/store/store-outcomes.ts` | first write only | nothing — insert-only | immutable; no annotation path exists |

Two models of obligation therefore coexist. **Prose obligations** (validation
policy text, brief `## Acceptance` prose, the reviewer proof sentence) steer an
agent but refuse nothing. **Structured subjects** (now `mergeHold` alone; the
verdict and pass-gate keys are retired) are attached to a named task and hold
the merge turn. Only the second kind is mechanical.

## Operator ruling

On 2026-10-24, Tom answered board decision
`0b728d57-b2f9-491e-8f0b-cc3837e1c45c` (version 2):
**“Implement Spec054 with existing gates (Recommended)”**.

This selected the precedence rule and fixed prompt instruction below, originally
using verdict pass gates and owner merge holds. Spec 058 cutover 2 retired the
verdict gates; exact-head operator source acceptance remains available. No prose
parser, new proof schema, editable outcome or live settings change is selected.
The prompt instruction is delivered under Queue #400 (layer 4 above); the
mechanical gates remain as described in the source-bound matrix.

## Selected rule

Use a precedence rule with three parts. It needs no new field, no new refusal
code and no schema migration.

1. **Scope belongs to the repository's validation authority; admission belongs
   to the brief.** The repository's AGENTS.md Validate section (formerly a
   stored `validationPolicy`, retired 2026-11-09) selects which covering checks
   run. It never decides whether a proof the brief names is a condition of
   merge. That condition is expressed in the brief’s prose.
2. **A brief that names a required proof names it in prose.** The proof is a
   named admission condition the retained reviewer judges at the exact head,
   recorded in its findings and ordinary verdicts. (Until Spec 058 cutover 2
   the proof also became a verdict id in `queue.reviewVerdicts` and an entry in
   `queue.reviewPassGate`; those keys are retired and refused at intake.) The
   reviewer's findings are where the citation lives; Nucleus still verifies no
   artifact — the retained reviewer's exact-head judgment is the admission
   decision, and a missing named proof is reported, not waved through.
3. **A proof only an owner can enable is declared with a merge hold.**
   `queue.mergeHold: true` plus `queue.mergeHoldReason` keeps the task off the
   merge gate entirely until the owner releases it, with the owner prompt,
   reminder and escalation that already exist (Spec 040). That is the right
   control for an activation step, because the reviewer can only report the
   missing evidence, not perform the activation.

Alongside it, one **non-overridable instruction** (prose, deliberately not
enforcement) is delivered outside the policy text, next to the existing
`HEAVY_VALIDATION_NOTE`/`REVIEWER_NO_FINDING_FOR_UNRUN_TESTS` constants. It
renders for brief- and handoff-mode tasks alike, because a committed handoff
names its proofs the same way:

- worker and revision prompts: "A repository validation policy selects which
  covering checks apply; it never waives a proof this brief names as required.
  If you cannot produce a named required proof, report it missing rather than
  claiming the work is complete."
- reviewer prompt: "A proof this brief names as required is an admission
  condition, not a validation detail, and no repository validation policy
  removes it. If the author's required proof is missing at this head, do not
  report ready_to_merge: report `changes_required` with
  `reviewResponsibility: author` when the author can still produce it, or
  `blocked` with `reviewResponsibility: environment` when it is owner-gated or
  unavailable. If the repository policy and the brief disagree about a missing
  proof, say so in the report and report blocked."

The instruction asks for honest reporting and a visible disagreement. A merge
hold keeps an owner-gated proof from merging until released; Nucleus does not
infer a mechanical gate from prose.

### Delivered implementation (Queue #400)

- **Where it renders.** `core/dispatch/prompts.ts` owns
  `REQUIRED_PROOF_AUTHOR_NOTE` and `REQUIRED_PROOF_REVIEWER_NOTE`. The author
  note renders in `workerPrompt`, `checkpointPrompt` and revision `runPrompt`
  through `requiredProofNote`; the reviewer note renders in reviewer
  `runPrompt` (including retained continuations) and
  `operatorReviewContinuationPrompt`.
  Closeout and recovery prompts gain nothing. The verification coordinator role
  is retired.
- **What did not change at delivery.** The historical policy renderer and
  `effectiveValidationPolicy` still rendered repository overrides verbatim,
  including an override contradicting the missing-proof sentence. Task 985
  later retired that rendering, as recorded above. No refusal, schema, wire
  field, proof tuple, settings write or artifact verifier was added, and no
  architecture review is produced from prose headings.
- **What still refuses (after Spec 058 cutover 2).** Intake refuses the retired
  `reviewVerdicts`/`reviewPassGate`/`manualVerification` keys with the
  replacement named, and `queue.mergeHold` remains the one mechanical subject.
  `assertReviewResponsibility` keeps responsibility and reviewer-only verdict
  checks. A reviewer who cannot produce a named proof reports
  `changes_required` (with `reviewResponsibility: author`) or `blocked`
  (with `reviewResponsibility: environment`); none of that mints a `pass` or an
  owner acceptance.
- **Operator authority is untouched.** Exact-head operator source acceptance
  still stands in for an independent review (`MergeGates.advanceMerging` and
  `verification` in `core/merge/merge-gates.ts`);
  no acceptance supplies a fabricated verdict.
- **Evidence.** `test/prompts.test.ts` fails if the instruction is missing under
  a default, an omitting or a contradicting policy, for worker, revision,
  reviewer, checkpoint and reviewer-continuation prompts in handoff mode;
  `test/review-verdicts.test.ts` covers ordinary verdicts and legacy rows
  reviewing without a verdict gate, while blocked/error findings stay recordable; `test/briefs.test.ts` compares the re-frozen handoff-mode
  prompt bytes against `test/fixtures/handoff-prompts.json`, whose frozen inputs
  are unchanged. Existing delivered turns are not silently reprompted: only new
  dispatch and new continuations render the instruction.

## Deterministic examples

Roles: **author** (worker/revision), **reviewer**, **owner** (operator).

| # | Configuration | Before Queue #400 | Delivered behaviour (Queue #400) |
| --- | --- | --- | --- |
| 1 | Author, default policy, prose-only brief, proof produced | policy block carries the default's blocker sentence | unchanged |
| 2 | Author, default policy, prose-only brief, proof missing | no gate; a `ready_for_review` is accepted; the reviewer may still approve honestly | unchanged mechanically; the author is told to report the proof missing, so a silent completion is a visible instruction breach |
| 3 | Author, Project-c revision 115, prose-only brief, proof missing (the retained `project-c#131` shape) | no gate; the reviewer's `ready_to_merge` is accepted with the gap disclosed; merge proceeds | unchanged mechanically — prose creates no subject. The reviewer must now name the brief/policy disagreement and report blocked instead of approving |
| 4 | Reviewer, brief names the proof in prose, report omits a judgment on it | no mechanical refusal; the retained reviewer judges the named proof at the head | unchanged mechanically; the retired `reviewVerdicts` key is refused at intake |
| 5 | Reviewer, retired `reviewPassGate: [author-native-proof]` in frontmatter | refused at intake with the replacement named | the retained reviewer reports missing proof as `changes_required` or `blocked` under prose acceptance |
| 6 | Reviewer, gate satisfied, then `amend_brief` adds an id | `refuseStaleReviewPassGate` returned the task to `awaiting_review` with `review_pass_gate_refused` | retired: the gate key is refused at `amend_brief`; the planner states the acceptance in prose |
| 7 | Reviewer, brief-assigned reviewer proof cannot be performed | prompt says report blocked; `blocked` is never refused for verdicts or gate; findings are retained on the run and head without publication or approval (Spec 037) | unchanged |
| 8 | Owner, `mergeHold: true` + reason, review otherwise complete | waits at `Merge held by operator; release to continue`, owner prompted, reminders then board escalation | unchanged |
| 9 | Owner, no hold, prose-only brief, proof never becomes available | nothing asks the owner; the task can merge | same, unless the planner used the hold — the visible fix is planning practice, not a new control |
| 10 | Absent structured fields | no verdict-shaped obligations remain; the fields stay readable on stored rows | absence stays legitimate; the reviewer still judges proof named in prose |
| 11 | Author tries to satisfy a gate itself | `Verdicts are only accepted for reviewer reports` | unchanged; verdicts remain reviewer-only, never self-certification |
| 12 | Retired keys in frontmatter | refused at submission/`amend_brief` with the replacement named | prose acceptance plus `queue.mergeHold` is the supported form |

## Original design comparison (before Spec 058 cutover 2)

Both, and they are not substitutes.

**Structured only** fixes admission but leaves the reviewer's judgement rule
undefined whenever the planner used prose: the reviewer is left reading a
repository policy that says "merge/close, preserve findings" against a brief that
says "ONE combined author native". A structured-only answer silently makes that
whole class of brief wrong without saying so.

**Instruction only** is cheap and universal but refuses nothing. It is exactly
the arrangement that produced the papercut: an honest reviewer, a disclosed gap,
and a merge. Making the sentence non-overridable improves what agents say; it
does not change what Nucleus admits.

**Both** originally paired the instruction with brief-declared verdict gates.
Those report-time gates were removed by Spec 058 cutover 2. The retained reviewer
now judges prose acceptance, and a needed mechanical hold uses `mergeHold`.

## Compatibility and migration

- **No schema migration.** The retired keys stay optional and readable on stored
  rows and frozen submission identities (`shared/contracts.ts`); new intake
  refuses them (`core/planning/handoff.ts`, `core/store/store.ts`,
  `core/verbs/brief.ts`). Stored
  tasks, briefs, runs, reviews and outcomes load unchanged.
- **No settings write at delivery.** The instruction changed prompt code, not
  saved repository policy or live settings. Task 985 later retired policy
  overrides; current prompts use `operatorValidationBlock` in
  `core/dispatch/prompts.ts` for the fixed repository-validation authority rule.
- **The default policy stays as written.** Keeping the blocker sentence inside
  `DEFAULT_VALIDATION_POLICY` costs only mild duplication for default-policy
  tasks and avoids editing the saved host setting or the exact-template
  compatibility path.
- **Retired keys are refused at amendment time.** `amend_brief` parses the new
  text under the brief schema, so a retired key is refused with the replacement
  named; `mergeHold` changes still apply in the same transaction with a
  `brief_merge_hold_changed` event.
- **Planning practice changes, not intake.** No submission is newly refused for
  a prose-only brief. Required proof is named in prose for reviewer judgment;
  owner-gated proof can use a merge hold. The planning guidance in
  [the Nucleus skill](../../../skills/nucleus/SKILL.md#required-proof)
  says so.

## Refusal implications

- Retired brief keys are refused at intake or amendment, not as a verdict
  completeness or pass check on reviewer reports.
- A blocked review keeps its run, exact head, full findings and structured
  verdicts without publishing an approval or granting pass credit (Spec 037,
  retired; the records remain).
- No refusal is invented from prose, and no owner acceptance is minted: an owner
  `move to=merge` still records accepted risk or binds the authentic review.

## Invariants this proposal must not disturb

- `insufficient` and `not_applicable` stay recordable and immutable; they are
  not reclassified, deleted or contradicted.
- Identity and exact-head gates are untouched: `input.head !== run.head`,
  `gate.head !== t.prHead`, review marker/login identity and the merge gate's
  settings-revision freshness all stay as they are.
- Terminal outcomes stay insert-only (`core/store/store.ts:2459`). Annotating or
  caveating a historical outcome is a separate unselected product feature; a
  merged task's record is never rewritten, and no owner acceptance is invented
  for it.
- No new proof tuple, guard or exception control. The existing hold remains
  available for a needed mechanical hold.

## Alternatives considered

- **Status quo.** Honest prose only; an override can drop the default's
  consequence without anyone noticing. Rejected: it is the papercut's shape.
- **Non-overridable instruction only.** Cheap and zero-migration, but refuses
  nothing; a cooperating reviewer still merges the Ox131 shape. Insufficient alone.
- **A new `requiredProof` field with its own gate.** Rejected: a new proof tuple
  duplicating the retired verdict/gate keys, plus a second refusal
  mechanism to keep consistent with re-review.
- **Infer required proof from brief prose.** Rejected: prose-to-authority
  inference, brittle, and it would let planning text acquire executable force.
- **Auto-add a gate from the brief's `## Acceptance` heading.** Rejected: same
  inference problem with a false sense of structure — headings are prose.
- **Block any brief whose acceptance prose has no structured subject.** Rejected:
  a prose heuristic becoming an intake refusal, and it would break stored briefs.
- **Annotate merged outcomes with the missing proof.** Out of scope; outcomes are
  immutable and annotation is an unselected feature.

## Acceptance

1. A source-bound matrix shows, for each gate, the code that fires it, the exact
   refusal and its blind spot. *(Above.)*
2. Examples 1–12 cover author, reviewer and owner roles, a repository override, a
   custom override that contradicts the default, absent structured fields, an
   explicit hold, and the retired keys' intake refusal.
3. The design and recorded ruling change no runtime behaviour by themselves;
   prompt delivery is separate.
4. Implementation is a separate task under the selected ruling: prompt constants plus
   planning guidance, then affected test files
   (`test/prompts.test.ts`, `test/review-verdicts.test.ts`) each run alone through
   Effigy. *(Delivered in Queue #400: the constants and the handoff-mode snapshot
   were updated only for this intentional prompt change, and each covering
   physical file ran alone.)*

## Evidence gaps

- The retained `project-c#131` evidence proves that merge, and proves no gate
  malfunction. It does not prove how often prose-only proof requirements reach
  merge; the Supervisor's bounded scan found no second clear example and this
  document does not claim one.
- Nothing in Nucleus can observe whether an agent actually ran a named proof. The
  proposal is explicit about this: it constrains the reviewer's admission
  judgment, not the physical proof.
- The disagreement in example 3 is currently resolved by agent judgement. How
  often a reviewer reads a merge-permissive repository policy over a proof-naming
  brief is not measurable from stored records.
