#!/usr/bin/env node
// Executable entry for a milestone QA supervisor (task 114). Run with the tsx
// loader available (node --import tsx) so the TypeScript pipeline resolves from
// the installed checkout. The service spawns it detached and unref'd, so it
// outlives the service and a Queue roll mid-run loses neither the run nor its
// recorded steps. Its one argument is the absolute path of the run's plan.
const { runQaSupervisorMain } = await import("../service/executor/project-qa-supervisor.ts");
await runQaSupervisorMain();
