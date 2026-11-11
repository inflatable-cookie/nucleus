import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PaseoAdapter } from '../service/paseo-composition';
import type { HostProcessFact } from '../core/machine/host-process-reap';

function adapter(processes: HostProcessFact[] | null) {
  const result = new PaseoAdapter('ws://127.0.0.1:1', join(process.cwd(), 'callback.sock'), join(process.cwd(), 'worker-report.mjs'));
  (result as any).api = { workspaces: { ref: () => ({ refresh: async () => true, current: () => ({ workspaceDirectory: '/workspace/task' }) }) } };
  result.hostProcessListing = async () => processes;
  return result;
}

const fact = (pid: number, command: string, cwd: string | null, ppid = 1): HostProcessFact =>
  ({ pid, ppid, pgid: ppid, uid: 501, startIdentity: `${pid}@fixture`, command, cwd });

test('Paseo process proof clears an idle participant only when the host scan is empty', async () => {
  assert.equal(await adapter([]).noLiveWorkspaceProcesses('workspace', ['run-1']), null);
  assert.match((await adapter([fact(7, 'bash build', '/workspace/task')]).noLiveWorkspaceProcesses('workspace', ['run-1'])) ?? '', /task workspace process tree/);
  assert.match((await adapter([fact(8, 'node /plugin/mcp-report.mjs /tickets/mcp-run-1.json', '/other')]).noLiveWorkspaceProcesses('workspace', ['run-1'])) ?? '', /still carries the run MCP ticket/);
  assert.match((await adapter(null).noLiveWorkspaceProcesses('workspace', ['run-1'])) ?? '', /host process listing is unreadable/);
});

/**
 * A daemon handle whose refresh answer, record and directory are each set by the test,
 * with every read logged in call order. The process proof reads the refresh's answer for
 * readability and the record's own directory, so each is pinned on its own.
 */
function handled(log: string[], handle: { refresh: unknown; record: unknown; directory?: string | null }, processes: HostProcessFact[] | null) {
  const result = new PaseoAdapter('ws://127.0.0.1:1', join(process.cwd(), 'callback.sock'), join(process.cwd(), 'worker-report.mjs'));
  (result as any).api = { workspaces: { ref: () => ({
    get directory() { log.push('directory'); return handle.directory; },
    refresh: async () => { log.push('refresh'); return handle.refresh; },
    current: () => { log.push('current'); return handle.record; },
  }) } };
  result.hostProcessListing = async () => { log.push('listing'); return processes; };
  return result;
}

test('Paseo process proof treats a falsy refresh as unreadable even with a retained record, and scans nothing', async () => {
  const log: string[] = [];
  const retained = { projectRootPath: '/repo', workspaceDirectory: '/workspace/task' };
  const answer = await handled(log, { refresh: null, record: retained, directory: '/workspace/task' }, [fact(7, 'bash build', '/workspace/task')])
    .noLiveWorkspaceProcesses('workspace', ['run-1']);
  assert.equal(answer, 'the participant workspace is unreadable for process proof');
  assert.deepEqual(log, ['refresh'], 'the record is not read and the process table is not listed after an unreadable refresh');
});

test('Paseo process proof scans the record\'s own directory, not the handle\'s, in the refresh-then-record order', async () => {
  const log: string[] = [];
  const handle = { refresh: true, record: { projectRootPath: '/repo', workspaceDirectory: '/workspace/task' }, directory: '/handle' };
  // A process inside the handle's folder is not the participant's tree: the record's folder decides.
  assert.equal(await handled(log, handle, [fact(7, 'bash build', '/handle')]).noLiveWorkspaceProcesses('workspace', ['run-1']), null);
  assert.deepEqual(log, ['refresh', 'current', 'listing'], 'the refresh is awaited, then the record is read, then the process table is listed');

  // A process inside the record's folder is the participant's tree, whatever the handle reports.
  assert.match((await handled([], handle, [fact(8, 'bash build', '/workspace/task')]).noLiveWorkspaceProcesses('workspace', ['run-1'])) ?? '', /task workspace process tree/);
});
