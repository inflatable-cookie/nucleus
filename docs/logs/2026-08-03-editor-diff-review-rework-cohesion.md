# Editor Diff Review Rework Cohesion

Date: 2026-08-03
Roadmap: `../roadmaps/g05/021-editor-diff-review-rework-cohesion.md`

## Result

The existing Editor, task Diff, review decision, and Agent Chat features now
form one short operator loop.

- task-diff overview carries the exact resource only when both snapshot
  manifests agree
- disagreement fails closed; missing or legacy lineage remains unknown
- Open in Editor routes the opaque file reference, safe display path, and exact
  resource together
- unknown resource lineage leaves Editor handoff disabled instead of guessing
- a current Needs changes result shows its durable note and one Address changes
  action
- the action focuses or creates Agent Chat with the selected Task attached
- any existing composer draft survives the panel switch and the bounded rework
  prompt is appended without rewriting it
- prompt preparation does not submit a message, start a provider turn, execute
  a Task, or transfer patch bytes

## Native Findings

The isolated bundle found two integration edges before closeout.

Longhorn tab activation committed and persisted, but the dock body retained the
previous panel. Nucleus now keys each dock only on its authoritative active
panel id. Tab bodies remount on activation, not resize ticks.

Agent Chat drafts were local to the active panel instance. Drafts now retain by
conversation across panel remounts, and accepted draft requests remount only
the composer. The native proof preserved `Keep this context`, appended the
review prompt, retained the selected Task attachment, and left Send untouched.

The copied legacy review snapshots did not contain resource lineage. Their
Open in Editor control is now disabled. Exact and mismatched lineage are covered
by focused Rust fixtures rather than inferred from the single-resource project.

## Evidence

- task-diff Rust fixtures: 4 passed
- desktop Bun tests: 43 passed
- mounted desktop tests: 18 passed
- desktop panel guards: 10 passed
- Svelte check: 0 errors; one pre-existing ProjectRail warning
- desktop production build: passed
- Rust workspace check: passed
- docs QA, Rust formatting, and diff hygiene: passed
- authenticated provider work: not run

Effigy Doctor still reports the pre-existing oversized-file findings and the
generated-in-source warning. This lane added neither class of finding; their
structural cleanup remains separate work.

## Next

Operator checkpoint. Use the closed loop, then choose the next g05 band:
Terminal/Browser/resource targeting and host status, or a different inward
consolidation priority.
