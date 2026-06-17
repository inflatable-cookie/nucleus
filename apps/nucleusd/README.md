# nucleusd

Rust server binary.

The current binary is a local server smoke surface. It opens the server-owned
SQLite state backend, can seed the local bootstrap project/task records, and
prints a state summary through the same control handler used by desktop
fixtures.

Run from the repo root:

```sh
cargo run -p nucleusd -- --bootstrap
```

Use an explicit state path:

```sh
cargo run -p nucleusd -- --state .nucleus/local/nucleus.sqlite --status
```

Inspect records through the local control handler:

```sh
cargo run -p nucleusd -- query projects
cargo run -p nucleusd -- query tasks
cargo run -p nucleusd -- query workspaces
```

Root Effigy selectors:

```sh
effigy server:bootstrap
effigy server:status
effigy server:query:tasks
effigy server:smoke
```

It does not open a network port, run a background daemon, execute commands,
start providers, or deliver subscriptions yet.
