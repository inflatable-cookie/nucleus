# 080 Specialist Panel Recovery Convergence

Status: completed
Owner: Tom
Created: 2026-08-04
Milestone: `../024-shell-accessibility-responsive-and-failure-cohesion.md`
Depends on: card 079
Auto-start next card: yes

## Objective

Apply the admitted state rules to specialist panels without flattening their
distinct runtime and product boundaries.

## Acceptance

- [x] Browser and Terminal retry preserve exact panel, project, and resource identity
- [x] Tasks, Memory, Editor, Diff, Files, Threads, and Forge keep failures with the issuing view
- [x] specialist technical evidence stays behind existing details or diagnostics
- [x] successful recovery clears only the owning local failure
- [x] no retry creates a duplicate panel or durable mutation

## Validation

- [x] focused panel recovery, stale-result, and duplicate-prevention fixtures pass

## Stop Conditions

- do not create a generic retry executor
- do not change provider, terminal, browser, file, task, or SCM authority

## Evidence

- Tasks, Memory, Files, Threads, and Forge now announce local read failures and
  expose the exact local refresh route. Mutation failures remain visible but
  are never replayed automatically.
- Browser and Terminal map failure to assertive alert semantics while preserving
  their existing panel-local reload or reopen identity.
- Existing editor, diff, file-tree, native-content, resource-target, and terminal
  fixtures retain stale-result, exact-target, and duplicate-prevention evidence.
