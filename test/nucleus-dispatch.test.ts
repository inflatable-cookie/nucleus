import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const shim = fileURLToPath(new URL('../engine/nucleus-dispatch', import.meta.url));

test('the cutover shim forwards arguments for Rust calls', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'nucleus-dispatch-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, '.nucleus/engine/bin/nucleus-engine');
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, `#!/bin/sh\nprintf '%s\\n' "$@"\n`, { mode: 0o700 });
  for (const [args, env] of [
    [['helper', 'report'], {}],
    [['plan.get'], { NUCLEUS_TICKET: '/fixture/ticket' }],
    [['plan.get'], { NUCLEUS_CONTINUATION_TICKET: '' }],
    [['plan.get'], { NUCLEUS_CONTINUATION_RUN_ID: 'previous-run' }],
    [['plan.get'], {}],
  ] as const) {
    const result = spawnSync(shim, args, { env: { HOME: home, ...env }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, [...args, ''].join('\n'));
  }
});
