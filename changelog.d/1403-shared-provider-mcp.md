Review, closeout and cleanup no longer mistake a T3 provider's own helpers for a
task's running tool.

T3 starts a thread's provider as `<provider> app-server …` under its connected
server, and one app-server can serve several threads. That app-server starts the
session's own standing helpers — `cua-driver mcp`, the provider's code-mode
runtime host such as `node_repl` — as its direct children, with the thread's
workspace as their cwd. A task worktree that happened to be one of those threads'
workspaces therefore looked like it held a live command, and review was refused
on a worktree nothing was running in (nucleus#1397). The owned-tool, review and
closeout workspace proofs, along with run cleanup and the terminal host-process
sweep, now recognise the whole chain: the live connected server, its live
`app-server`-mode child, and that app-server's live, non-shell `mcp`-mode or
runtime-host direct children.

The boundary is unchanged elsewhere. A process that merely carries a helper's
name, anything below those direct children, a shell, a live run's own report
helper and a same-shaped app-server whose parent is a shell or another daemon all
still hold.
