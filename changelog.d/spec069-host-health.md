### Changed

- Host health now comes from each host's connection alone (Spec 069 §2). A host is `up`, `degraded` (connected, but three host passes in a row hung or failed at the transport), `down` (the connection is lost; T3 drops it after two missed heartbeats) or `unknown` (not yet seen since the service started). A failed or slow call fails only its own step and never changes the host's state, and no single failure rewrites every task on the host. A degraded host keeps its running work and takes one new task at a time until a clean pass.
- A service restart no longer parks tasks. While the new service waits for a host to connect (up to five minutes), the host reads `unknown` and its tasks keep their state; nothing is written for them.
- The host-outage record is opened and closed only when a host goes down or comes back, so an outage costs one write however many passes observe it.
