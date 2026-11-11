#!/usr/bin/env node
// Detached host-run supervisor (contract 010, Client protocol v1). Its durable
// result file lets Queue's endpoint reattach a run after a service roll without
// launching the command again. Its one argument is the run's plan file.
const { runHostRunSupervisorMain } = await import("../service/executor/host-run-supervisor.ts");
await runHostRunSupervisorMain();
