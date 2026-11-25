# Contracts

Durable rules Nucleus runs on. Detailed design for each capability is in
[specs/](../specs/README.md).

| Contract | Owns |
| --- | --- |
| [working-rules.md](working-rules.md) | How work moves through this repository |
| [orchestration.md](orchestration.md) | Durable orchestration behaviour: dispatch, review, merge, closeout, recovery, and the daemon owner map |
| [repository-hooks.md](repository-hooks.md) | Historical TypeScript repository hooks and current merge policy |
| [durable-telemetry.md](durable-telemetry.md) | Historical TypeScript telemetry records and metrics |
| [service-boundary.md](service-boundary.md) | The standalone Nucleus service and the Paseo bridge |
| [repository-layout.md](repository-layout.md) | Where code and documents live in this repository |
| [agent-local-paths.md](agent-local-paths.md) | Local path registry for agents |
| [release.md](release.md) | Local engine staging, release and recovery authority |
| [milestone-qa.md](milestone-qa.md) | Report-only milestone QA and its lane document |
| [writing-style.md](writing-style.md) | Internal writing style |
| [host-run-scheduling-010.md](host-run-scheduling-010.md) | Contract 010 and the current Effigy admission-hook boundary |
