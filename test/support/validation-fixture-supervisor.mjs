// The prospective-merge fixture commands never fork; inventory only their PID.
import { overrideIdentityListing } from '../../core/machine/process-identity-search.ts';
import { runProjectValidationSupervisorMain } from '../../service/executor/project-validation-supervisor-runner.ts';
import { noCpuReads } from './scoped-identity.ts';
overrideIdentityListing({ state: 'absent' });
await runProjectValidationSupervisorMain(undefined, { cpuReads: noCpuReads });
