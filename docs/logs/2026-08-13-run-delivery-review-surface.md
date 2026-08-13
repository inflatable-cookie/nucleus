# Run Delivery Review Surface

Date: 2026-08-13
Card: `docs/roadmaps/g05/batch-cards/102-run-delivery-review-surface.md`
Branch: `thread/102-run-delivery-review-surface`

## Outcome

Delivered runs now have a first-class review surface. Two worker sessions
died mid-card (flash stream stall, then a silent exit); the second left a
complete, uncommitted implementation in the worktree, which the orchestrator
verified and committed with this log.

- **Read model** (`crates/nucleus-server/src/request_handler/run_review.rs`):
  one delivered run's review projection — objective, acceptance, stop
  conditions, provider, worktree/base refs, closeout, transition log, parsed
  validation evidence (`validation:effigy-test-plan:*`, `changed-files:N`,
  `delivery:commit-created`, `delivery:push-executed`), and the run branch's
  diff against the fork point bound at dispatch. Read-only: the module never
  mutates the run, the worktree, or the registry.
- **Disposition**: accept/reject ride the ordinary run command path
  (registry transitions with receipts), not a parallel mutation channel.
- **Desktop**: `RunReviewPanel.svelte` renders the closeout, validation
  result, and diff overview with accept/reject actions; the Runs fleet rows
  open the review surface for delivered runs. Fixtures in
  `runReviewPanel.fixture.ts` + `RunReviewPanel.vitest.ts`.
- **Plumbing**: review query/response DTOs through the control envelope
  (bindings regenerated into `apps/desktop/src/lib/control/generated`).

## Validation

- `bun run check` (apps/desktop) — 0 errors, 0 warnings.
- `bun run test` — 71 bun pass; vitest 37 passed / 1 failed (the known
  pre-existing `settingsDialog` tabindex failure from the longhorn sweep —
  not this card).
- `cargo test -p nucleus-server run_review` — 9 passed.
- `cargo test -p nucleus-engine run_commands` — 13 passed.

No roadmap, milestone, card, or dispatch status files were modified. No
swallowtail, longhorn, or poodle sources were modified.
