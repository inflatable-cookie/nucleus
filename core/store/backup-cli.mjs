/**
 * The backup worker's command line (Spec 028). Plain JavaScript, so the
 * pre-migration snapshot runs before the store opens without a TypeScript loader.
 *
 * It is a separate entry rather than a block inside `backup-worker.mjs`: the service
 * imports that module to list snapshots and read their health in process, and an
 * imported module must never be able to run a command as a side effect. A TypeScript
 * import of the worker can load it a second time under the loader's transform, so a
 * command inside it could run twice.
 *
 * `manual` is the operator's Back up now, recorded as manual in the backup status.
 * `migration` runs before a schema upgrade and writes only the pre-migration snapshot.
 * Exit code 2 says the backup volume is away rather than that a snapshot failed, so a
 * pre-migration snapshot can report an outage the migration survives (Spec 028).
 */
import { createBackup, isStorageUnavailable } from './backup-worker.mjs';

const [mode, dbPath, dir, sourcePath] = process.argv.slice(2);
// An async body, not top-level await: tests load this module through a CJS transform.
void (async () => { try {
  const options = mode === 'migration-staged' ? { admittedSource: { path: sourcePath, fd: 3 } } : mode === 'manual' ? { origin: 'manual' } : {};
  const result = mode === 'now' || mode === 'manual' || mode === 'migration' || mode === 'migration-staged' ? await createBackup(dbPath, dir, undefined, options) : null;
  if (!result) throw new Error('Unknown backup command');
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = isStorageUnavailable(error) ? 2 : 1;
} })();
