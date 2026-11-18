import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import {
  overrideCommandTokenSearch,
  overrideWorktreeAddSearch,
} from "../../core/machine/process-identity";
import {
  overrideIdentityListing,
  processStartIdentityLiveness,
} from "../../core/machine/process-identity-search";
import { hostRunProcessStartIdentity } from "../../core/machine/start-identity";
import {
  qaSupervisionPaths,
  qaSupervisionPlanSchema,
  readQaSupervision,
} from "../../core/qa/project-qa-supervision-files";
import type { ProjectQaRunner } from "../../core/qa/project-qa";
import { identityListingForRecords } from "./scoped-identity";

/** The test's own supervisors and the single escaped child it explicitly publishes. */
export function scopedQaFixture(
  t: TestContext,
  roots: string[],
  escapeRecord?: string,
  measureCpu = false,
) {
  const supervisors = new Map<
    string,
    { pid: number; startIdentity: string; planPath: string }
  >();
  const unstarted = new Set<string>();
  const previous = process.env.QUEUE_FIXTURE_ESCAPE_RECORD;
  const previousCpu = process.env.QUEUE_FIXTURE_MEASURE_CPU;
  if (measureCpu) process.env.QUEUE_FIXTURE_MEASURE_CPU = "1";
  if (escapeRecord) process.env.QUEUE_FIXTURE_ESCAPE_RECORD = escapeRecord;
  overrideWorktreeAddSearch((path) =>
    roots.some((root) => path.startsWith(`${root}/`))
      ? { state: "absent" }
      : { state: "unknown" },
  );
  overrideCommandTokenSearch((token) => {
    const supervisor = supervisors.get(token);
    if (!supervisor)
      return unstarted.has(token) ? { state: "absent" } : { state: "unknown" };
    const live = processStartIdentityLiveness(
      supervisor.pid,
      supervisor.startIdentity,
    );
    return live === "alive"
      ? { state: "found", pid: supervisor.pid }
      : live === "dead"
        ? { state: "absent" }
        : { state: "unknown" };
  });
  overrideIdentityListing((token) => {
    const supervisor = supervisors.get(token);
    if (!supervisor)
      return unstarted.has(token) ? { state: "absent" } : { state: "unknown" };
    try {
      const plan = qaSupervisionPlanSchema.parse(
        JSON.parse(readFileSync(supervisor.planPath, "utf8")),
      );
      const state = readQaSupervision(
        qaSupervisionPaths(plan.runRoot, plan.runId, plan.attempt).statePath,
      );
      if (!state) return { state: "unknown" };
      if (!state.activeProcess)
        return !escapeRecord && !state.inFlight
          ? { state: "absent" }
          : { state: "unknown" };
      const records = [
        {
          pid: state.activeProcess.pid,
          identity: state.activeProcess.startIdentity,
        },
      ];
      if (escapeRecord)
        records.push(JSON.parse(readFileSync(escapeRecord, "utf8")));
      return identityListingForRecords(token, records);
    } catch {
      return { state: "unknown" };
    }
  });
  t.after(() => {
    overrideCommandTokenSearch(null);
    overrideWorktreeAddSearch(null);
    overrideIdentityListing(null);
    if (previous === undefined) delete process.env.QUEUE_FIXTURE_ESCAPE_RECORD;
    else process.env.QUEUE_FIXTURE_ESCAPE_RECORD = previous;
    if (previousCpu === undefined) delete process.env.QUEUE_FIXTURE_MEASURE_CPU;
    else process.env.QUEUE_FIXTURE_MEASURE_CPU = previousCpu;
  });
  const attach = (runner: ProjectQaRunner) => {
    runner.options.supervisorEntry = fileURLToPath(
      new URL("../fixtures/qa-scoped-supervisor.mjs", import.meta.url),
    );
    const spawn = runner.spawnQaSupervisor.bind(runner);
    runner.spawnQaSupervisor = (planPath, token, temporaryDirectory) => {
      const pid = spawn(planPath, token, temporaryDirectory);
      supervisors.set(token, {
        pid,
        startIdentity: hostRunProcessStartIdentity(pid),
        planPath,
      });
      unstarted.delete(token);
      return pid;
    };
  };
  attach.adopt = (
    token: string,
    pid: number,
    startIdentity: string,
    planPath: string,
  ) => {
    supervisors.set(token, { pid, startIdentity, planPath });
    unstarted.delete(token);
  };
  attach.knownAbsent = (token: string) => {
    unstarted.add(token);
  };
  return attach;
}
