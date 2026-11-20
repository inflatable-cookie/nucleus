#!/usr/bin/env node
// Internal implementation: the ACP agent an ACP-capable app registers as a provider.
// A host launches it in a task's checkout; it speaks Agent Client Protocol on stdio
// and reads its Nucleus binding from the data home (Spec 065).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataHome } from '../shared/data-home.mjs';
import { ensureDaemonForT3 } from '../service/transport/index.mjs';
import { runAcpAgentFromEnvironment } from '../shared/acp/entry.ts';

// T3Code probes this launcher on its own cold start, with no thread (nucleus#1394).
// Starting the daemon for a configured local T3 host is best effort and never waits:
// a failure here is a line on stderr, and the agent still answers its protocol.
try {
  ensureDaemonForT3({ dataDir: dataHome(), root: resolve(dirname(fileURLToPath(import.meta.url)), '..') });
} catch (error) {
  process.stderr.write(`nucleus-acp: could not start the Nucleus daemon for T3Code: ${error instanceof Error ? error.message : String(error)}\n`);
}

process.exitCode = await runAcpAgentFromEnvironment();
