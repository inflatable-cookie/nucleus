# Failure Notification Routing

Date: 2026-08-11
Card: g05.097

## Result

Operator-facing project command refusals now publish warning records from the
Tauri host into `nucleus:desktop-notifications`. The route observes rejected
project command receipts at `submit_control_envelope`; the renderer never
publishes ledger records. Records use source `nucleus:commands`, retain the
bounded refusal reason and project scope, and use the command id as the opaque
cause reference. ProjectRail and ThreadsSidebarView no longer render permanent
inline refusal blocks for those commands.

## Routing decision

Contract 032, Notifications (§Notifications, lines 251-280), assigns the
`nucleus:desktop-notifications` authority to the desktop host: Nucleus owns
which facts notify, wording, redaction, severity, actions, authorization, and
delivery policy; the primary renderer may mark, dismiss, or clear but may not
publish or replace records. Its existing operation publication is a host-side
precedent, not a renderer route.

Longhorn contract 016 (§Boundary, lines 9-17; §Authority, lines 35-52) keeps
the ledger independently usable for non-operation facts and assigns consumers
the operation-to-notification policy. That admits command refusals as a
Nucleus-owned fact at the host adapter edge. The implementation therefore
intercepts the already-authoritative Tauri control response after the server
returns a rejected command receipt. It does not add a server dependency on
Longhorn and does not let the renderer call `Add`.

The refusal reason remains the product receipt detail required by this card;
project scope and command id remain bounded/opaque metadata. No action
reference is attached because project command retry/admission is not yet an
allowlisted notification action.

## Converted paths

- `ProjectRail.svelte`: project create/lifecycle/resource command refusals are
  host-published warning records. The permanent `mutationFailure` rail and
  manager blocks were removed. Project read failure keeps its retry affordance
  because it is a catalogue/transport failure, not a command refusal.
- `ThreadsSidebarView.svelte`: project create/promote refusals use the same
  host route and no longer populate the sidebar failure block. Thread loading,
  thread rename/delete, and transport failures stay inline with retry or local
  context; they are not project-command refusal records.

## Remaining inline-error disposition

- `AgentChatPanel.svelte`: intentionally inline for now. Turn failures are
  transcript/agent-runtime facts, while question, plan, actor-selection, and
  provider failures are tied to the active composer or decision surface. These
  are not project command refusals and need a separate admission policy.
- `ProjectResourceManager.svelte` and `ProjectSharedFilesManager.svelte`:
  intentionally inline. These messages are inside an open resource-management
  dialog and preserve the immediate field/action context; the host still
  records rejected project-resource commands.
- `ThreadsSidebarView.svelte` read/thread-management failure: intentionally
  inline because the retry action reruns the exact local read and the failures
  are thread/transport facts.
- `settings/pages/LazySettingsPage.svelte` and
  `settings/pages/NucleusRestoreSettingsPage.svelte`: intentionally inline.
  Dynamic page loading and restore inspection/confirmation errors belong to the
  open settings workflow and have no command-refusal notification admission.
- `EditorPanel.svelte`: intentionally inline. Disk conflicts, save/load
  failures, and the keep-editing/reload decisions require the live editor
  buffer and local recovery actions.
- `MemoryPanel.svelte` and `TaskListPanel.svelte`: intentionally inline read
  failures with local Retry controls; they are query/transport failures, not
  operator command refusals.
- `BrowserPanel.svelte`, `DiffPanel.svelte`, `ForgeDiffPanel.svelte`, and
  `TerminalPanel.svelte`: needs its own card. These are native-island,
  review-workflow, Forge, or terminal transport/runtime failure classes. They
  must not be forced through the project-command refusal source or lose their
  contextual recovery actions.

## Fixtures and validation

- Rust fixture: `command_refusal_is_warning_with_reason_and_project_scope`
  (desktop notification runtime).
- Renderer fixture: `routes a refused project mutation without a permanent rail
  alert` (`ProjectRail.vitest.ts`).
- `effigy desktop:test`: passed (71 Bun tests; 24 Vitest tests).
- `effigy desktop:check`: passed (0 errors, 0 warnings).
- `cargo fmt --all -- --check`: passed.
- `cargo test -p nucleus-desktop notifications::tests`: passed (4 tests).
- `cargo test -p nucleus-server`: not run; `nucleus-server` sources were not
  modified.

Longhorn and poodle sources were not modified. Roadmap, milestone, card, and
dispatch status files were not modified.
