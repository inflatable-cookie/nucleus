#!/usr/bin/env node
// Legacy ACP protocol entrypoint for isolated TypeScript fixtures.
import { runAcpAgentFromEnvironment } from '../shared/acp/entry.ts';

process.exitCode = await runAcpAgentFromEnvironment();
