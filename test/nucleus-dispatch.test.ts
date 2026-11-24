import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const shim = fileURLToPath(new URL('../engine/nucleus-dispatch', import.meta.url));

test('the cutover shim preserves Effigy worktree hook arguments and normal Rust calls', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'nucleus-dispatch-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [file, engine] of [
    ['.local/bin/nucleus-legacy', 'legacy'],
    ['.nucleus/engine/bin/nucleus-engine', 'rust'],
  ] as const) {
    const target = join(home, file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, `#!/bin/sh\nprintf '%s\\n' ${engine} "$@"\n`, { mode: 0o700 });
  }
  for (const [expected, args, env] of [
    ['legacy', ['worktree', 'prepare', '/fixture checkout'], {}],
    ['legacy', ['worktree', 'link', '/fixture checkout'], {}],
    ['legacy', ['worktree', 'unlink', '/fixture checkout'], {}],
    ['rust', ['helper', 'report'], {}],
    ['rust', ['plan.get'], { NUCLEUS_TICKET: '/fixture/ticket' }],
    ['rust', ['plan.get'], { NUCLEUS_CONTINUATION_TICKET: '' }],
    ['rust', ['plan.get'], { NUCLEUS_CONTINUATION_RUN_ID: 'previous-run' }],
    ['rust', ['plan.get'], {}],
  ] as const) {
    const result = spawnSync(shim, args, { env: { HOME: home, ...env }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, [expected, ...args, ''].join('\n'));
  }
});
