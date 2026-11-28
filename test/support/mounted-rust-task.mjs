import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { buildEngineBoard } from '../../scripts/build-web.mjs';

const origin = process.env.BOARD_FIXTURE_ORIGIN;
const cookie = process.env.BOARD_FIXTURE_COOKIE;
assert.ok(origin && cookie);
const root = await mkdtemp(join(process.env.TMPDIR, 'mounted-task-'));
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: origin, runScripts: 'dangerously', pretendToBeVisual: true,
});
const shutdown = new AbortController();
const fetcher = (input, options = {}) => {
  const headers = new Headers(options.headers);
  headers.set('cookie', cookie);
  headers.set('x-nucleus-board', '1');
  if (options.method && options.method !== 'GET') headers.set('origin', origin);
  const signal = options.signal ? AbortSignal.any([shutdown.signal, options.signal]) : shutdown.signal;
  return fetch(origin + String(input), { ...options, headers, signal });
};
const eventually = async (check, message) => {
  const deadline = Date.now() + 8000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(check(), `${message}; page: ${text()}`);
};
const text = () => dom.window.document.body.textContent ?? '';
const control = label => dom.window.document.querySelector(`[aria-label="${label}"]`);
const click = async label => {
  await eventually(() => control(label), `visible control: ${label}`);
  control(label).click();
};
try {
  await buildEngineBoard(root);
  Object.assign(dom.window, {
    matchMedia: () => Object.assign(new dom.window.EventTarget(), { matches: true }),
    fetch: fetcher, TextDecoder, TextEncoder, AbortController,
  });
  dom.window.eval(`(() => { ${await readFile(join(root, 'app.js'), 'utf8')} })()`);
  await click('Queue, 1');
  await click('#1, Standalone task');
  await eventually(() => control('Task detail'), 'task opens');
  const detail = control('Task detail');
  await eventually(() => detail.querySelector('[aria-label="Progress"]'), 'one scrolling view loads');
  assert.equal(detail.querySelector('[role="tablist"]'), null, 'the view has no tabs');
  await eventually(() => control('Hold'), 'available Hold action');
  assert.equal(control('Release'), null, 'unavailable Release action is absent');
  const detailText = () => detail.textContent ?? '';
  await click('Brief, collapsed');
  await eventually(() => detailText().includes('complexity: low'), 'brief opens in place');
  await click('Show Markdown source');
  const before = await (await fetcher('/api/engine/tasks/board-task')).json();
  const updatedBrief = '---\nqueue:\n  complexity: low\n---\n# Updated from another session';
  const amended = await fetcher('/api/engine/tasks/board-task/commands', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-nucleus-board': '1' },
    body: JSON.stringify({ amend: updatedBrief, briefVersion: before.brief.version }),
  });
  assert.equal(amended.status, 200);
  await eventually(() => detailText().includes(updatedBrief), 'the open brief updates on invalidation');
  await click('Hold');
  await eventually(() => control('Reason'), 'hold reason field');
  const reason = control('Reason');
  assert.ok(reason);
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(reason, 'Wait for fixture');
  reason.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await click('Hold task');
  await eventually(() => detailText().includes('Wait for fixture'), 'hold is stored and displayed');
  const held = await (await fetcher('/api/engine/tasks/board-task')).json();
  assert.equal(held.hold.reason, 'Wait for fixture');
  await eventually(() => control('Release'), 'real guard offers Release after hold');
} finally {
  shutdown.abort();
  dom.window.close();
  await rm(root, { recursive: true, force: true });
}
