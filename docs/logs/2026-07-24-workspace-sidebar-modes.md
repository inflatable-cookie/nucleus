# Workspace Sidebar Modes

Date: 2026-07-24

## Outcome

The global project rail is now a four-mode workspace sidebar:

- Projects retains project selection, creation, lifecycle, and resource control.
- Threads owns quick chats and reads compact summaries from persisted chat
  sessions.
- Files projects host-admitted files into one tree per selected-project working
  resource.
- Forge lists recorded Git resources across projects.

Only one view is visible. Project selection and the mounted Projects controller
survive view changes. Sidebar mode and width remain local client state.

Persisted thread rows now carry their conversation identity into the selected
project's Agent Chat panel. The workspace queues cross-project requests until
that project's retained panel layout has loaded, then focuses an existing chat
panel or creates one before hydrating history.

Splitter drag feedback is now local to the splitter. The outer sidebar and
project region layouts commit their retained ratios on mouse release instead
of replacing application layout state or writing storage on every mouse move.
Native Browser views pause bounds synchronization for the same gesture and
resume at the final geometry. Agent Chat backdrop blur also pauses during the
gesture to avoid resize-time WebKit recompositing.

The shared Poodle resize primitive now batches raw mouse movement to animation
frames and removes per-move container measurements.

## File Opening

Files uses the existing admitted editor-file list boundary. Selecting a file
opens or focuses an Editor bound to its resource. A different resource gets a
matching Editor instead of silently retargeting a potentially dirty buffer.

## Forge Boundary

Forge currently shows recorded repository health and default-branch hints. It
does not claim live working-tree state and exposes no stage, commit, push, or
provider mutation controls.

## Evidence

- desktop type checks pass with no diagnostics
- 20 focused client tests pass, including file-tree projection
- 4 focused persisted-chat tests pass
- 12 focused Swallowtail adapter tests pass
- 49 native desktop tests pass
- the production renderer build passes
- docs QA and diff hygiene pass

The local Swallowtail checkout added harness UI callbacks and operation-scoped
callback ids. Nucleus now rejects unsupported task-time harness UI requests
fail-closed and returns callback responses against the original turn or run
scope. A resource-access assertion now follows Swallowtail's optional policy
shape. These compatibility changes restore the native desktop build without
granting new callback authority.

## Remaining Gate

Confirm the native sidebar proportions, all four view transitions, one
multi-resource file open, and the Forge information hierarchy.
