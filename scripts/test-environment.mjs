import { existsSync, mkdtempSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Run before product imports in each physical test worker. A helper fork may
// inherit --import, but its own entry is not a test and keeps its chosen data home.
if (process.env.NODE_TEST_CONTEXT && /\.test\.(?:[cm]?[jt]s|[jt]sx)$/.test(process.argv[1] ?? '')) {
  const scratch = process.env.TMPDIR;
  if (!scratch || !isAbsolute(scratch) || !existsSync(scratch))
    throw Error('Tests require an existing absolute TMPDIR for isolated runtime state');
  const root = mkdtempSync(join(scratch, 'nt-'));
  process.env.NUCLEUS_DATA_HOME = join(root, 'data');
  delete process.env.NUCLEUS_WORK_ROOT;
  delete process.env.NUCLEUS_WORK_VOLUME_ID;
  delete process.env.NUCLEUS_LOCAL_WORKSPACE_ROOT;
  delete process.env.NUCLEUS_RETAINED_WORKSPACE_ROOTS;
  // Every work-volume class is its own setting (nucleus#1526); none may leak in
  // from the developer's shell and re-place a fixture's writes.
  delete process.env.NUCLEUS_BACKUP_ROOT;
  delete process.env.NUCLEUS_PROJECT_QA_ROOT;
  delete process.env.NUCLEUS_SCRATCH_ROOT;
  delete process.env.NUCLEUS_CUSTODIAN_ROOT;
}
