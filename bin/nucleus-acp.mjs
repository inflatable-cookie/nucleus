#!/usr/bin/env node
// Internal implementation: the ACP agent an ACP-capable app registers as a provider.
// A host launches it in a task's checkout; it speaks Agent Client Protocol on stdio
// and reads its Nucleus binding from the data home (Spec 065).
import { runAcpAgentFromEnvironment } from '../shared/acp/entry.ts';

process.exitCode = await runAcpAgentFromEnvironment();
