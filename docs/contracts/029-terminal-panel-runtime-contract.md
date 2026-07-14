# 029 Terminal Panel Runtime Contract

Status: draft-promoted-first-pass
Owner: Tom
Updated: 2026-07-14

## Purpose

Define terminal session authority, transport, lifecycle, and client rendering
before the Terminal panel starts processes.

## Core Rule

A terminal runs on the authoritative terminal host for its project. It does
not inherently run on the desktop client.

The renderer owns xterm presentation only. The terminal host owns:

- project working-directory resolution
- shell selection and environment
- PTY creation and process lifecycle
- input, resize, output, exit, and cleanup
- session attachment and bounded reconnect replay

## Authority And Routing

`ProjectAuthorityDomain::Terminal` is the preferred assignment. A legacy map
without that domain may use its execution assignment only when source access is
available on the same host.

The client resolves a host route before opening or attaching. It must not send
an arbitrary working directory, executable, or authority claim.

Topology examples:

- embedded desktop host: PTY and shell run in the desktop host process
- local sidecar: PTY and shell run in the sidecar
- remote authoritative host: client streams terminal frames to that host
- remote worker: allowed only when the project authority map assigns terminal
  authority and the worker can resolve the project source location

## Session Identity

One host session has:

- stable session id
- project id
- panel/resource ref
- authoritative host id
- current rows and columns
- lifecycle state
- monotonically increasing output sequence

Panel movement, tab selection, region collapse, renderer remount, and short
transport loss detach the view. They do not close the session.

Explicit panel close closes the session and its process tree. Host shutdown
also closes hosted sessions.

## Protocol

The product-facing terminal client stays low-cardinality:

- `open_or_attach`
- `input`
- `resize`
- `close`

The host streams:

- `output`
- `exited`
- `diagnostic`

Output remains byte-oriented. Transport adapters must not require lossy UTF-8
conversion. Input and resize preserve ordering per session.

## Reconnect And Backpressure

The host retains a bounded recent output buffer for live sessions. Attach may
replay that buffer with sequence ids before live output resumes.

The buffer is interaction recovery, not durable transcript storage. Slow or
disconnected clients must not create unbounded host memory. A gap diagnostic
must be possible when requested output has already been evicted.

## Transport Adapters

The terminal client is transport-neutral.

- Tauri IPC and channels may adapt an embedded desktop host.
- Local sockets or named pipes may adapt a sidecar.
- An authenticated bidirectional remote stream may adapt a remote host.

Tauri commands are not the durable terminal API. Remote transports must expose
the same session operations and event semantics.

## First Runtime

The first host runtime uses `portable-pty`. The first renderer uses
`@xterm/xterm` plus `@xterm/addon-fit`.

Initial shell rules:

- resolve the host user's configured shell
- fall back to a platform shell when unavailable
- start inside the host-resolved project root
- advertise `TERM=xterm-256color`, `COLORTERM=truecolor`, and
  `TERM_PROGRAM=Nucleus`

The default xterm renderer is sufficient for the first slice. WebGL, links,
search, serialization, persisted transcripts, and terminal collaboration are
deferred.

## Security And Product Boundaries

- terminal input is an explicit operator action
- agents do not type into an operator terminal without separate authority
- terminal output does not enter agent context, tasks, memory, or evidence by
  default
- credentials and environment values are never copied into durable terminal
records
- remote session access requires authenticated, project-scoped host access
- terminal execution remains distinct from admitted agent command execution

## First Slice

The first slice must prove:

- local host open or attach through the transport-neutral client
- interactive input and streamed byte output
- container-driven PTY resize
- survival across panel remount and movement
- explicit close and host cleanup
- visible host/session failure without a permanent toolbar

Remote pairing, authentication, network transport, and cross-client terminal
sharing remain blocked on their focused contracts. The local slice must not
make those later adapters require a Terminal panel rewrite.
