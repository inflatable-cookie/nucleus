import type { HostProcessFact } from "../../core/host/types";
import { readBbSessionEnvironments } from "../../core/machine/host-process-listing";
import { darwinBbThreadFromProcargs } from "../../core/machine/run-process-identity";

/** BB daemon, bridge, session and its MCP server; session environment follows the real reader. */
export async function bbProcessFixture(
  directory: string,
  thread: string | null = "thr_fixture",
): Promise<HostProcessFact[]> {
  const fact = (
    pid: number,
    ppid: number,
    command: string,
  ): HostProcessFact => ({
    pid,
    ppid,
    pgid: pid,
    uid: 501,
    startIdentity: `${pid}@fixture`,
    command,
    cwd: directory,
  });
  const bb = "/Applications/bb.app/Contents/MacOS/bb";
  const facts = [
    {
      ...fact(100, 1, `${bb} /opt/host-daemon/dist/daemon-bundle.mjs`),
      cwd: "/elsewhere",
    },
    fact(
      101,
      100,
      `${bb} /opt/host-daemon/dist/bb-provider-bridge-worker.mjs /artifact plugin /data`,
    ),
    fact(102, 101, "/fixture/bin/claude --output-format stream-json"),
    fact(103, 102, "/fixture/bin/cua-driver mcp"),
  ];
  await readBbSessionEnvironments(facts, {
    identity: async (pid) => ({ kind: "identity", identity: `${pid}@fixture` }),
    platform: "darwin",
    bbThreads: async () =>
      new Map([
        [
          102,
          thread === null
            ? null
            : darwinBbThreadFromProcargs(
                Buffer.concat([
                  Buffer.from([1, 0, 0, 0]),
                  Buffer.from(
                    `/fixture/claude\0\0claude\0OTHER=contains BB_THREAD_ID=wrong\0BB_THREAD_ID=${thread}\0\0`,
                  ),
                ]),
              ),
        ],
      ]),
  });
  return facts;
}
