import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';

test('deleted intake re-export shims are neither build entries nor runtime aliases', async () => {
  for (const path of [
    'core/intake/callback-client.mjs', 'core/intake/callback-client.d.mts',
    'core/intake/report-binding.mjs', 'core/intake/report-binding.d.mts',
  ]) {
    await assert.rejects(access(new URL(`../${path}`, import.meta.url), constants.F_OK), { code: 'ENOENT' });
  }
  const build = await readFile(new URL('../scripts/build-runtime.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(build, /core\/intake\/(?:callback-client|report-binding)\.(?:mjs|d\.mts)/);
});
