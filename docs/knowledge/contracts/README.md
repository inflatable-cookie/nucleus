# Contracts

Durable rules Nucleus runs on. Detailed design for each capability is in
[specs/](../specs/README.md).

| Contract | Owns |
| --- | --- |
| [working-rules.md](working-rules.md) | How work moves through this repository |
| [orchestration.md](orchestration.md) | Durable orchestration behaviour: dispatch, review, merge, closeout, recovery, and the daemon owner map |
| [repository-hooks.md](repository-hooks.md) | Repository manifests and hooks for consumer repositories |
| [durable-telemetry.md](durable-telemetry.md) | Telemetry records and metrics |
| [service-boundary.md](service-boundary.md) | The standalone Nucleus service and the Paseo bridge |
| [repository-layout.md](repository-layout.md) | Where code and documents live in this repository |
| [agent-local-paths.md](agent-local-paths.md) | Local path registry for agents |
| [release.md](release.md) | How the plugin is rolled onto the live checkout |
| [writing-style.md](writing-style.md) | Internal writing style |
| [host-run-scheduling-010.md](host-run-scheduling-010.md) | Contract 010 host-run protocol for Effigy v0.14 clients (imported from Nucleus; until the R2 cutover) |
