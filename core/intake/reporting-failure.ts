import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Completion } from '../../shared/contracts';
import { wireLabel } from '../../shared/wire-labels';
import type { AgentObservation } from '../host/adapter';
import { digest } from '../store/store';
import { mcpBindingPathFromHostRecord } from './report-binding';

/** A stopped thread with a missing local MCP binding cannot deliver its result.
 * Record the observed failure, never recover credentials from another ticket.
 * Unknown/foreign paths and filesystem errors other than absence prove nothing.
 */
export function missingReportBindingCompletion(helperPath: string | undefined,
  identity: { taskId: string; runId: string; head?: string; coordinatorGeneration?: number },
  state: AgentObservation): Completion | null {
  if (!helperPath || state.active || state.permissions || !['idle', 'error', 'closed'].includes(state.status)) return null;
  const key = wireLabel(state.labels, 'mcpBinding');
  if (!key || !/^[a-zA-Z0-9_-]+$/.test(key)) return null;
  const expected = join(dirname(helperPath), 'tickets', `mcp-${key}.json`);
  const observed = state.mcpBindingPath ?? mcpBindingPathFromHostRecord(state);
  if (!observed || resolve(observed) !== resolve(expected)) return null;
  try { statSync(expected); return null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
  const summary = `Report binding missing for run ${identity.runId}: ENOENT at ${expected}. The thread cannot report; use the existing restart or recovery route.`;
  return { ...identity, eventId: digest(`report_binding_missing:${identity.taskId}:${identity.runId}`),
    status: 'error', headline: 'Report failed because its binding is missing', summary, impediment: summary,
    cause: { kind: 'external', name: 'Missing MCP report binding' } };
}
