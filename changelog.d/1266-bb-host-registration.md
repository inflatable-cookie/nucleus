A BB server can now register with Nucleus as a host. Its plugin proves its identity
over the host-operation channel — the BB server's real data directory is hashed into
the host identity and a read-only probe (`status.get`, `system.version`, one
`threads.list`, `hosts.list`) must succeed before any declaration is accepted — and the service records that identity, gives it its own
admission and breaker state, and reports it in `service.health` with the announced BB
and plugin-SDK versions and, while it is offline, the field that refused it. A changed
data directory, a missing field or a refused schema takes the host offline by name, and
a reconnect proves the identity again. The BB plugin also holds the same single bridge
presence claim the Paseo bridge holds, and the plugin-lost fault now names the connected
host's own reload command (`bb plugin reload nucleus` for BB).

Repositories can opt into it with `repository.set hostKind: "bb"`; Paseo stays the
default host, T3Code is unchanged, and a live task never changes host. BB dispatches no
task yet: the registered host refuses every task-workflow call by name.
