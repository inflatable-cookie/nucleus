#!/usr/bin/env node
// Fixture entry for a QA command whose only escaped child, if any, publishes
// its own start identity into the private record named by the test.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { assertCheckoutAvailable } from '../../core/workspaces/checkout-volume.ts';
import { qaSupervisionPaths, readQaSupervision, qaSupervisionPlanSchema } from '../../core/qa/project-qa-supervision-files.ts';
import { overrideWorktreeAddSearch } from '../../core/machine/process-identity.ts';
import { overrideIdentityListing as overrideProcessIdentity } from '../../core/machine/process-identity-search.ts';
import { runQaSupervisorMain } from '../../service/executor/project-qa-supervisor.ts';
import { identityListingForRecords, noCpuReads, singleCommandCpuReads } from '../support/scoped-identity.ts';

const plan = qaSupervisionPlanSchema.parse(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const { statePath } = qaSupervisionPaths(plan.runRoot, plan.runId, plan.attempt);
overrideWorktreeAddSearch(path => path === plan.checkoutPath ? { state: 'absent' } : { state: 'unknown' });
overrideProcessIdentity(token => {
  if (token !== plan.identityToken) return { state: 'unknown' };
  const state = readQaSupervision(statePath);
  if (!state?.activeProcess) return { state: 'unknown' };
  const records = [{ pid: state.activeProcess.pid, identity: state.activeProcess.startIdentity }];
  if (process.env.QUEUE_FIXTURE_ESCAPE_RECORD) {
    try { records.push(JSON.parse(readFileSync(process.env.QUEUE_FIXTURE_ESCAPE_RECORD, 'utf8'))); }
    catch { return { state: 'unknown' }; }
  }
  return identityListingForRecords(token, records);
});
let admission;
if (plan.externalCheckout) {
  const mount = dirname(dirname(dirname(dirname(plan.checkoutPath))));
  const relativeToTemp = relative(realpathSync(tmpdir()), realpathSync(mount));
  if (relativeToTemp.startsWith('..') || !relativeToTemp || join(mount, 'queue', 'project-qa') !== dirname(dirname(plan.checkoutPath)))
    throw new Error('fixture supervisor requires a private temporary mount');
  admission = target => assertCheckoutAvailable({ mount, uuid: 'fixture', target,
    observe: () => ({ MountPoint: mount, VolumeUUID: 'fixture', Internal: false, Writable: true, WritableVolume: true }) });
}
const cpuReads = process.env.QUEUE_FIXTURE_MEASURE_CPU ? singleCommandCpuReads(statePath, true) : noCpuReads;
await runQaSupervisorMain(undefined, admission, cpuReads);
