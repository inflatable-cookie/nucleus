# Browser Panel Runtime Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-07-14

## Purpose

Define the first desktop browser-panel boundary without turning remote web
content into part of the trusted Nucleus shell.

## First Runtime Shape

The desktop host renders each Browser panel with two layers:

- trusted Nucleus chrome in the main bundled webview
- remote HTML in a separate native child webview

The child uses the platform engine supplied through Tauri: WKWebView on macOS,
WebView2 on Windows, and WebKitGTK on Linux. Nucleus does not ship a second
browser engine in this slice.

One child webview is keyed by one browser panel id. Moving or temporarily
hiding a panel reuses that child for the lifetime of the desktop process.
Closing the panel destroys it.

## Trust Boundary

Only the bundled main webview receives Nucleus Tauri capabilities. A remote
browser child receives no Nucleus IPC, command, filesystem, window, or control
permissions.

Remote content cannot own or mutate project, task, goal, workspace, panel, or
provider state. Trusted toolbar actions cross a narrow host command boundary.
Operator-entered navigation accepts only `http` and `https` URLs. Inputs
without a scheme receive `https://`. Invalid and unsupported URLs fail closed.

On macOS, the child may report an allowlisted CSS cursor name through a private
document-title sentinel so the host can mirror it onto Tao's parent cursor
rectangle. The bridge accepts no arbitrary command or payload and grants no
Tauri IPC access.

Page-internal navigation, cookies, authentication state, and rendering remain
native-engine concerns. The first slice uses the engine's normal shared data
store. Nucleus state must not persist cookies or credential material.

The host observes page-load transitions and publishes URL and loading state to
the trusted toolbar. Page-internal navigation is admitted only for `http` and
`https`; custom schemes and local-file navigation fail closed.

## Panel Lifecycle

The trusted panel chrome owns the child webview's logical bounds. It must:

- create or recover the child when the Browser panel becomes active
- keep child position and size aligned with the rendered viewport
- hide the child when the panel unmounts, becomes inactive, collapses, or a
  workspace tab drag begins
- show and resynchronize the child when the active panel returns
- destroy the child when its Browser panel closes

The main window ending also ends all child webviews. In-process reuse may
preserve current URL and native session state. Cross-restart browser-tab
restoration is not promised by this contract.

## First Controls

The trusted toolbar provides:

- back
- forward
- reload
- URL entry
- open current URL in the system browser

Control failures stay in the trusted chrome. Remote pages must not be allowed
to spoof those failures as Nucleus messages.

## Deferred Surface

The first slice does not promise:

- downloads
- popup or multi-window handling
- permission prompts owned by Nucleus
- extensions
- browser automation
- devtools UI
- persisted history or bookmarks
- remote-worker browser sessions

Those require an explicit follow-on contract expansion. The first runtime
blocks popup and download requests and reports that decision in trusted panel
chrome. A destination leaves Nucleus only through the explicit system-browser
action; remote content must not silently gain a trusted Nucleus window or write
a download to disk.

## Ownership

This contract owns the desktop browser-panel trust and lifecycle boundary.
`006-workspace-layout-contract.md` owns panel placement and persistence.
`007-server-boundary-contract.md` and `017-engine-host-authority-contract.md`
continue to own authoritative host commands and project authority. A future
browser/preview-control contract may extend automation and remote execution
without weakening this boundary.
