# Desktop

Future Tauri control plane.

The desktop app will be the first client for nucleus, but it must not own
durable project, task, workspace, or agent state.

No Tauri project is scaffolded yet.

The first desktop bootstrap profile should prefer Tauri IPC once implemented,
with an in-process transport remaining useful for early local tests. Transport
and Tauri IPC schema readiness are tracked in `nucleus-server`; no desktop
transport is implemented yet.

Desktop scaffolding remains deferred until IPC command handling and
serialization are testable through the server boundary.
