import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callerRollProgress } from '../shared/caller.mjs';

test('ticket caller resolution explains an active roll and says the CLI control was not applied', () => {
  const root = mkdtempSync(join(tmpdir(), 'nucleus-caller-roll-'));
  try {
    writeFileSync(join(root, 'queue-service-roll.json'), JSON.stringify({
      status: 'replacing', at: new Date(100_000).toISOString(), detail: 'Replacing service',
    }));
    assert.equal(callerRollProgress(root, 106_500),
      'Nucleus service roll in progress (replacing, 6s elapsed); retry shortly. Caller identity was not resolved, so the requested control was not applied.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a stale or settled roll does not mask the ordinary caller resolution path', () => {
  const root = mkdtempSync(join(tmpdir(), 'nucleus-caller-roll-'));
  try {
    writeFileSync(join(root, 'queue-service-roll.json'), JSON.stringify({
      status: 'rolled', at: new Date(100_000).toISOString(), detail: 'Replacement ready',
    }));
    assert.equal(callerRollProgress(root, 106_500), null);
    writeFileSync(join(root, 'queue-service-roll.json'), JSON.stringify({
      status: 'typechecking', at: new Date(100_000).toISOString(), detail: 'Building while service remains live',
    }));
    assert.equal(callerRollProgress(root, 106_500), null);
    writeFileSync(join(root, 'queue-service-roll.json'), JSON.stringify({
      status: 'replacing', at: new Date(100_000).toISOString(), detail: 'Old roll',
    }));
    assert.equal(callerRollProgress(root, 1_000_000), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
