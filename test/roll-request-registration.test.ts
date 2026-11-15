import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onRepositorySyncRollRequest, requestServiceRollAfterRepositorySync } from '../core/forge/roll-request';
import { sourcePathFromModule } from '../shared/service/build';
import { consumeServiceRollRequest, registerServiceRollRequest, SERVICE_ROLL_REQUEST_FILE } from '../service/install/roll-request';

test('runtime registration binds the advisory effect to the core roll port', () => {
  const root = mkdtempSync(join(tmpdir(), 'roll-request-registration-'));
  const previousDataHome = process.env.NUCLEUS_DATA_HOME;
  const dataDir = join(root, 'nucleus-data');
  process.env.NUCLEUS_DATA_HOME = dataDir;
  try {
    const sourcePath = sourcePathFromModule();
    onRepositorySyncRollRequest(() => false);
    assert.equal(requestServiceRollAfterRepositorySync(sourcePath), false);
    registerServiceRollRequest();
    assert.equal(requestServiceRollAfterRepositorySync(sourcePath), true);
    assert.equal(existsSync(join(dataDir, SERVICE_ROLL_REQUEST_FILE)), true);
    assert.equal(consumeServiceRollRequest(dataDir)?.force, false);
  } finally {
    onRepositorySyncRollRequest(() => false);
    if (previousDataHome === undefined) delete process.env.NUCLEUS_DATA_HOME;
    else process.env.NUCLEUS_DATA_HOME = previousDataHome;
    rmSync(root, { recursive: true, force: true });
  }
});
