import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { pidAlive } from '../../core/machine/pid';
import { readProcessSubset } from '../../core/machine/host-process-listing';
import { overrideCommandTokenSearch } from '../../core/machine/process-identity';
import { overrideIdentityListing, processStartIdentityLiveness } from '../../core/machine/process-identity-search';
import { hostRunProcessStartIdentity } from '../../core/machine/start-identity';
import { readProjectValidationResult, readProjectValidationSupervisorState } from '../../core/qa/project-validation-supervisor';
import type { RepositoryHooks } from '../../core/hooks/hooks';
import { identityListingForRecords } from './scoped-identity';

type RecordOfSupervisor = { pid: number; startIdentity: string; planPath: string };
const supervisors = new Map<string, RecordOfSupervisor>();
let fixtures = 0;

/** The supervisors and their published, non-forking commands are the fixture inventory. */
export async function validationFixtureHostListing() {
  const pids = [process.pid];
  for (const record of supervisors.values()) {
    if (pidAlive(record.pid)) pids.push(record.pid);
    const state = readProjectValidationSupervisorState(join(dirname(record.planPath), 'supervisor.json'));
    if (state?.activeProcess && pidAlive(state.activeProcess.pid)) pids.push(state.activeProcess.pid);
  }
  const read = await readProcessSubset(pids);
  return read.state === 'listed' ? read.processes : null;
}

/** Attach to the exact supervisors this fixture starts; all its commands are non-forking. */
export function scopedValidationFixture(t: TestContext) {
  fixtures++;
  const owned = new Set<string>();
  overrideCommandTokenSearch(token => {
    const record = supervisors.get(token);
    if (!record) return { state: 'unknown' };
    const live = processStartIdentityLiveness(record.pid, record.startIdentity);
    return live === 'alive' ? { state: 'found', pid: record.pid } : live === 'dead' ? { state: 'absent' } : { state: 'unknown' };
  });
  overrideIdentityListing(token => {
    const record = supervisors.get(token);
    if (!record) return { state: 'unknown' };
    const state = readProjectValidationSupervisorState(join(dirname(record.planPath), 'supervisor.json'));
    if (!state || state.identityToken !== token) return { state: 'unknown' };
    if (!state.activeProcess) {
      const result = readProjectValidationResult(join(dirname(record.planPath), 'result.json'), state.runId);
      return result && result.identityToken === token && result.pid === null && result.processGroupId === null
        && result.outputTail.startsWith('Validation launch failed:') ? { state: 'absent' } : { state: 'unknown' };
    }
    return identityListingForRecords(token, [{ pid: state.activeProcess.pid, identity: state.activeProcess.startIdentity }]);
  });
  t.after(() => {
    for (const token of owned) supervisors.delete(token);
    if (--fixtures === 0) { overrideCommandTokenSearch(null); overrideIdentityListing(null); }
  });
  return (hooks: RepositoryHooks) => {
    hooks.options.validationSupervisorEntry = fileURLToPath(new URL('./validation-fixture-supervisor.mjs', import.meta.url));
    const runner = (hooks as any).projectValidation;
    const spawn = runner.spawnValidationSupervisor.bind(runner);
    runner.spawnValidationSupervisor = (planPath: string, token: string) => {
      const pid: number = spawn(planPath, token);
      supervisors.set(token, { pid, startIdentity: hostRunProcessStartIdentity(pid), planPath });
      owned.add(token);
      return pid;
    };
  };
}
