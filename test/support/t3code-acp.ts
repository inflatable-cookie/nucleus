import type { AcpSessionSurface } from "../../shared/acp/surface";
import { PARENT_MODEL, PARENT_PROVIDER } from "../../hosts/t3code/nesting";

/**
 * The Nucleus ACP provider a T3 host needs to create a role child (nucleus#1366):
 * the instance `nucleus t3 install` registers, and the ACP session surface the
 * parent's held turn runs on. Tests that create role threads serve both; a test
 * that proves the refusal serves neither.
 */
export const nucleusProvider = {
  instanceId: PARENT_PROVIDER,
  displayName: "Nucleus",
  driver: "acpRegistry",
  enabled: true,
  status: "ready",
  models: [{ slug: PARENT_MODEL, name: "Nucleus" }],
};

/** What the stub reads from the fake's thread map: each projection's runs and provider. */
export interface AcpThread {
  runs: Array<{ status: string }>;
  thread: { providerInstanceId: string };
}
type ThreadMap = ReadonlyMap<string, unknown>;

/** The ACP surface: a release ends the parent thread's held turn, as the agent does. */
export function acpStub(threads: ThreadMap) {
  const released: string[] = [];
  const surface: AcpSessionSurface = {
    bind: (input) => ({
      sessionId: `session:${input.taskId}`,
      taskId: input.taskId,
      bindingPath: `/synthetic/acp/${input.taskId}.json`,
    }),
    async turn() {
      throw new Error("the agent is not driven in this test");
    },
    async message() {
      throw new Error("the agent is not driven in this test");
    },
    release(sessionId) {
      released.push(sessionId);
      for (const projection of threads.values() as Iterable<AcpThread>) {
        if (projection.thread.providerInstanceId !== PARENT_PROVIDER) continue;
        for (const run of projection.runs)
          if (["preparing", "starting", "running", "waiting"].includes(run.status))
            run.status = "completed";
      }
    },
  };
  return { surface, released };
}

/**
 * Serve the Nucleus provider beside the ones the fake already answers. Read the
 * served list first: a `providers` override replaces it, and a fixture that sets
 * only the Nucleus instance loses the synthetic provider it launches roles on.
 */
export async function serveNucleusProvider(
  host: { rpc: { call(method: string, payload: unknown): Promise<unknown> } },
  server: { controls: { providers?: unknown[] } },
): Promise<void> {
  const served = (await host.rpc.call("server.getConfig", {})) as {
    providers: unknown[];
  };
  server.controls.providers = [
    ...served.providers.filter(
      (provider) =>
        (provider as { instanceId?: string }).instanceId !== PARENT_PROVIDER,
    ),
    nucleusProvider,
  ];
}
