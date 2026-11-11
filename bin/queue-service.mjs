#!/usr/bin/env node
// Executable entry for the standalone Nucleus service. Run with the
// tsx loader available (node --import tsx) so the TypeScript service modules
// resolve from the installed checkout. Spawned detached by the bridge only
// when the service is definitely absent; it drains on SIGTERM/SIGINT.
const { runStandaloneService } = await import("../service/standalone.ts");
await runStandaloneService();
