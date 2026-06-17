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

The project switcher is deferred until Rust exposes display-ready project
records and an intentional local seed or create path.

Local desktop startup now seeds a `Nucleus Local` project through the Rust
server state path. This is bootstrap readiness, not full project creation UI.

The next desktop panel is a read-only project switcher. It should list and
select server-owned project records without adding project creation or editing.

The project switcher panel exists and reads `project_records` DTOs. Selection
is local shell state and is not persisted or sent to the server.

Task list UI is deferred until Rust exposes an intentional local task seed or
create path.

The chosen task runway mirrors project records: Rust owns task storage codec,
server projection, and seeded bootstrap data. The `task_records` DTO now
exists; desktop should only render it after bootstrap task data exists.
