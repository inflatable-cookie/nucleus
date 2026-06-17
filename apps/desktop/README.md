# Desktop

Initial Tauri control plane.

The desktop app is the first nucleus client, but it does not own durable
project, task, workspace, or agent state. Durable authority stays in the Rust
server boundary.

The scaffold uses Bun, Svelte, Tauri v2, and Poodle components from
`../poodle`. The TypeScript layer is intentionally thin: it builds the shell,
constructs a control request DTO, invokes a Tauri command, and renders the DTO
response.

The first command path is `submit_control_envelope`. It routes a serialized
control envelope through `nucleus-server`'s `TauriIpcControlCommandAdapter` and
the local request handler.

No project panels, terminal/browser/editor surfaces, SCM controls, live
subscriptions, provider processes, remote transport, or command execution exist
in this app yet.

The first real panel is control diagnostics. It proves command-path health,
protocol versioning, backend reachability, and error rendering before project
or task panels depend on mutation flows that do not exist yet.

Diagnostics can issue read-only runtime metadata queries and project, task, or
workspace list queries. The TypeScript helpers only construct DTOs and invoke
Tauri; they do not own or reinterpret server state.

Command history now has a typed desktop helper. `queryCommandHistory` requests
`list_command_evidence`, parses the typed command evidence response, and
returns explicit records, empty, unsupported, error, or unexpected states.
Desktop code must use that helper instead of decoding command evidence storage
records.

The first command diagnostics panel should be read-only. It may render command
history rows, selected evidence detail, sanitized summaries, status, exit
status, retention mode, and artifact refs. It must not expose command run,
cancel, retry, approval, artifact download, PTY, or streaming controls.

Rust owns command history records, command authority, artifact resolution,
runtime execution, storage payloads, and IPC routing. Svelte owns only local
view state such as selected evidence id, loading state, last error, and
refresh intent. The panel can be replaced later without changing server state
or storage.

The first disposable command diagnostics panel now exists. It uses
`queryCommandHistory`, renders typed command evidence records, and keeps all
selection/loading/error state local to Svelte. It is still proof UI, not final
diagnostics design.

Desktop startup now seeds one deterministic sanitized command evidence record
through Rust server state so the panel is useful in a local bootstrap install.
The seed does not execute a command, retain raw output, or create artifact
payloads.

Runtime readiness now has a typed desktop helper. `queryRuntimeReadiness`
requests `get_local_runtime_readiness`, parses typed readiness diagnostics,
and returns explicit records, empty, unsupported, error, or unexpected states.
It exposes host id, runtime surface, status, blockers, evidence refs, repair
hints, and summary only. It must not become a runtime repair or command
approval path.

The first disposable runtime readiness panel now exists. It renders typed
readiness records, blockers, evidence refs, hints, and status from the helper.
It is read-only proof UI and does not expose runtime repair, command approval,
artifact payload, PTY, or streaming controls.

The project switcher is deferred until Rust exposes display-ready project
records and an intentional local seed or create path.

Local desktop startup now seeds a `Nucleus Local` project through the Rust
server state path. This is bootstrap readiness, not full project creation UI.

The next desktop panel is a read-only project switcher. It should list and
select server-owned project records without adding project creation or editing.

The project switcher panel exists and reads `project_records` DTOs. Selection
is local shell state and is not persisted or sent to the server.

Task list UI is deferred until readiness is reassessed against the new task
record and seed boundary.

The chosen task runway mirrors project records: Rust owns task storage codec,
server projection, and seeded bootstrap data. The `task_records` DTO now
exists and desktop startup seeds one bootstrap task through the Rust server.

The desktop now has a read-only task list panel. It queries server-owned task
records and renders DTO fields only. It does not create, edit, assign, or run
tasks.

The task list filters visible records by the selected project id as local view
glue. Server authority remains unchanged.

The shell also tracks a local selected task id. Selection is not persisted and
does not imply task mutation authority.

The task detail panel is read-only. It renders the selected task DTO and does
not expose assignment, execution, or edit controls.

The desktop control helper layer can now build command DTOs for the supported
task activity transitions. UI controls are still limited to the explicit
transition subset.

Task detail exposes controls only for start, block, complete, and archive.
Unsupported task mutations are still absent.

Accepted transition commands trigger a server refresh. The task list and detail
panel update from refreshed DTOs rather than optimistic local mutation.
