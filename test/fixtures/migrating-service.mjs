// A Queue service that reports a store migration from its first moment, waits
// FIXTURE_MIGRATION_MS, then starts the real service in the same process while
// the migration marker is still open. The cold start counts as migrating, as a
// real start's snapshot and schema steps do, so a heavily loaded host's slow
// module load never races the readiness budget (combined QA 7719ee26, 2026-10-21).
// FIXTURE_NO_MARKER=1 makes it a silent slow start instead.
// FIXTURE_MAINTENANCE_MS reports a bounded store-maintenance window instead of (or as well
// as) a migration, which is the phase the one-shot store conversion runs in.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { markMaintenance, markMigration, SPAWN_TOKEN_ENV } from '../../service/install/standby.ts';

const dataDir = join(process.env.PASEO_HOME, 'northstar-queue');
const delay = Number(process.env.FIXTURE_MIGRATION_MS);
const maintenance = Number(process.env.FIXTURE_MAINTENANCE_MS ?? 0);
const startedAt = Date.now(), token = process.env[SPAWN_TOKEN_ENV];
if (process.env.FIXTURE_NO_MARKER !== '1') markMigration(dataDir, process.pid, token, startedAt);
await new Promise(resolve => setTimeout(resolve, delay));
const gate = async phase => {
  if (process.env.FIXTURE_GATE_PHASE !== phase) return;
  while (!existsSync(process.env.FIXTURE_RELEASE_FILE)) await new Promise(resolve => setTimeout(resolve, 10));
};
await gate('migration');
if (maintenance > 0) {
  const maintenanceStartedAt = Date.now();
  if (process.env.FIXTURE_NO_MARKER !== '1') markMaintenance(dataDir, process.pid, token, maintenanceStartedAt);
  await new Promise(resolve => setTimeout(resolve, maintenance));
  await gate('maintenance');
  if (process.env.FIXTURE_NO_MARKER !== '1') markMaintenance(dataDir, process.pid, token, maintenanceStartedAt, Date.now());
}
await import('../../bin/queue-service.mjs');
