import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

test('paused projection waiters yield and queued cleanup runs after unpause', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', join(process.cwd(), 'test/support/cleanup-pause-probe.ts')],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', timedOut = false;
  let deadline = setTimeout(() => { timedOut = true; child.kill(); }, 15_000);
  child.stdout.on('data', data => {
    output += String(data);
    if (output.includes('started\n') && !output.includes('settled\n')) {
      clearTimeout(deadline);
      deadline = setTimeout(() => { timedOut = true; child.kill(); }, 2_000);
    }
  });
  child.stderr.on('data', data => { errors += String(data); });
  const [code] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.on('exit', (code, signal) => resolve([code, signal])));
  clearTimeout(deadline);
  assert.equal(timedOut, false, `paused projection wait blocked the event loop: ${output} ${errors}`);
  assert.equal(code, 0, errors);
  assert.match(output, /settled/);
});
