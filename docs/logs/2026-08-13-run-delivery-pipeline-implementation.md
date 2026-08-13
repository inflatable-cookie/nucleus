# Run Delivery Pipeline Implementation

Date: 2026-08-13
Card: `docs/roadmaps/g05/batch-cards/101-run-delivery-pipeline.md`
Branch: `thread/101-run-delivery-pipeline`

## Outcome

Implemented and pushed the phase-1 run delivery pipeline. A completed worker turn now supplies closeout evidence to the server, which runs the repository validation hook in the isolated worktree, records validation and changed-file evidence, writes the per-delivery operator confirmation intent, and invokes the existing gated branch/worktree runner for `git add` and `git commit`. When a remote target exists, the same gated runner also performs the run-branch push. Only after commit succeeds does the run transition to `delivered`.

The delivery command is exposed through the control DTO/envelope surface. No-remote projects omit the push command and still deliver the local run branch. Push failure preserves a successful local commit and the existing authority receipt explains the failed push without blocking delivery.

Delivery success is published by the desktop host notification authority. Delivery command refusal is routed through the same host path; renderer code does not publish notifications.

The operation-truth boundary remains the existing `local_codex_chat/run_transitions.rs` precedent: the delivery command is submitted only after the observed worker turn returns, while failure transitions continue to use observed operation truth.

## Authority boundary

Delivery confirmation is persisted before gated execution. The implementation does not spawn bare git for delivery and does not widen authority to primary-tree mutation, force push, forge/PR creation, merge, provider effects, callbacks, recovery, task mutation, or raw output retention. Dispatch-time worktree creation and per-delivery commit/push confirmation remain separate intents.

No roadmap, milestone, card, or dispatch status files were modified. No swallowtail, longhorn, or poodle sources were modified.

## Validation

- `cargo check -p nucleus-server` — passed.
- `cargo test -p nucleus-server provider_git_branch_worktree_runner --lib` — passed (33 tests, including push-failure and replay fixtures).
- `cargo test -p nucleus-server request_handler --lib` — passed (133 tests).
- `cargo test -p nucleus-server --test module_ratchet` — passed.
- `cargo test -p nucleus-engine -p nucleus-orchestration` — passed (114 engine, 22 orchestration).
- `effigy qa:docs` — passed.
- `effigy desktop:test` — Bun suite passed (71 tests); the known pre-existing Vitest settings dialog tabindex failure remains.
- `cargo check -p nucleus-desktop` — blocked by the known pre-existing missing `apps/desktop/dist` required by `tauri::generate_context!`.
- `git diff --check` — passed before the implementation commit.

Implementation commit: `f18b4ff7` (`Implement run delivery pipeline`).
