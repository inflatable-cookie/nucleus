import type { HostProcessFact } from '../../core/host/types';
import { readBbSessionEnvironments } from '../../core/machine/host-process-listing';
import { runProcessEnvironments } from '../../core/machine/run-process-identity';

/** BB daemon, bridge, session and its MCP server; session environment follows the real reader. */
export async function bbProcessFixture(directory: string, thread: string | null = 'thr_fixture'): Promise<HostProcessFact[]> {
  const fact = (pid: number, ppid: number, command: string): HostProcessFact =>
    ({ pid, ppid, pgid: pid, uid: 501, startIdentity: `${pid}@fixture`, command, cwd: directory });
  const bb = '/Applications/bb.app/Contents/MacOS/bb';
  const facts = [
    { ...fact(100, 1, `${bb} /opt/host-daemon/dist/daemon-bundle.mjs`), cwd: '/elsewhere' },
    fact(101, 100, `${bb} /opt/host-daemon/dist/bb-provider-bridge-worker.mjs /artifact plugin /data`),
    fact(102, 101, '/home/user/.local/bin/claude --output-format stream-json'),
    fact(103, 102, '/home/user/.local/bin/cua-driver mcp'),
  ];
  await readBbSessionEnvironments(facts, {
    identity: async pid => ({ kind: 'identity', identity: `${pid}@fixture` }),
    environments: (pids, options) => runProcessEnvironments(pids, { ...options, platform: 'darwin',
      darwinRead: async () => {
        if (thread === null) throw Error('unreadable');
        return `102 ${facts[2]!.command} BB_THREAD_ID=${thread} BB_PROJECT_ID=prj_fixture\n`;
      } }),
  });
  return facts;
}
