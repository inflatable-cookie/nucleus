#!/usr/bin/env node
// Detached project-validation runner. Its result file lets Queue recover a
// completed verdict after a service roll without launching the command again.
const { runProjectValidationSupervisorMain } = await import("../service/executor/project-validation-supervisor-runner.ts");
await runProjectValidationSupervisorMain();
