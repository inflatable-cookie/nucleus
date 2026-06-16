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
