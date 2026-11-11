import { test } from "node:test";
import assert from "node:assert/strict";
import * as forge from "../core/forge/index";
import { readStash, validateDispatch, verifyCheckpoint, verifyCleanQueueWorktree, verifyPr, verifyReplacementSource, verifyResume, verifyWorkspace } from "../core/git/index";
import { MachinePorts } from "../core/machine/machine-ports";
import { PaseoAdapter } from "../service/paseo-composition";
import { checkoutRunScratchPlacement, runScratchRoot, runTemporaryDirectory } from "../core/workspaces/run-scratch";
import type { Task } from "../shared/contracts";

/**
 * Step 3 row 2 of the Paseo host split (task 871): the machine ports leave
 * `server/paseo.ts` for a core-owned module the adapter extends. These
 * witnesses pin what a move could quietly break — the ports stay the core
 * function references themselves, a Git or forge port stays an instance field
 * so an override wins and a stand-in carries none, the load and process probes
 * stay prototype methods core reads optionally, and the scratch policy reads
 * the adapter at call time.
 */

const adapter = () => new PaseoAdapter("ws://127.0.0.1:1", "/unused/callback.sock", "/unused/worker-report.mjs");
const task = () => ({ repoPath: "/src/repo", repository: "example/repo" }) as Task;

/** Every pure Git and forge port, with the core function it must be. */
const ports: Array<[string, unknown]> = [
  ["validate", validateDispatch], ["verifyWorkspace", verifyWorkspace], ["verifyPr", verifyPr],
  ["verifyPrIdentity", forge.verifyPrIdentity], ["verifyInspectedRevisionHead", forge.verifyInspectedRevisionHead],
  ["verifyContinuedProgress", forge.verifyContinuedProgress], ["findOpenBranchPr", forge.findOpenBranchPr],
  ["findAnyOpenBranchPr", forge.findAnyOpenBranchPr], ["verifyCancelledWorkspacePr", forge.verifyCancelledWorkspacePr],
  ["verifyResume", verifyResume], ["verifyCheckpoint", verifyCheckpoint], ["verifyReplacementSource", verifyReplacementSource],
  ["verifyCleanQueueWorktree", verifyCleanQueueWorktree], ["readStash", readStash],
  ["publishReview", forge.publishReviewOnce], ["reconcileReviewPublication", forge.reconcileFormalReviewPublication],
  ["externalMerge", forge.externalMerge], ["mergeGate", forge.mergeGate], ["requiredChecks", forge.requiredChecks],
  ["coveringEvidence", forge.coveringEvidence], ["rerunFailedWorkflowRuns", forge.rerunFailedWorkflowRuns],
  ["merge", forge.merge], ["merged", forge.merged], ["syncMain", forge.syncMain], ["verifyCloseout", forge.verifyCloseout],
];

test("the adapter carries the core Git and forge functions themselves, not a wrapper", () => {
  const machine = adapter();
  assert.ok(machine instanceof MachinePorts, "the machine ports are on the adapter's own chain");
  for (const [name, port] of ports) assert.equal((machine as unknown as Record<string, unknown>)[name], port, `${name} is the core function`);
});

test("a Git or forge port stays an instance field, so an override wins and a stand-in gains none", async () => {
  const machine = adapter();
  const override: PaseoAdapter["verifyPr"] = async () => ({ url: "https://example.test/pull/1", head: "a".repeat(40), repository: "example/repo", headRepository: "example/repo", crossRepository: false });
  machine.verifyPr = override;
  assert.equal(machine.verifyPr, override, "the instance field shadows the port");
  assert.equal((await machine.verifyPr(task(), 1)).url, "https://example.test/pull/1");
  for (const [name] of ports) assert.equal(name in MachinePorts.prototype, false, `${name} stays an instance field, not a prototype method`);
});

test("the load and process probes stay prototype methods on the adapter", () => {
  // Core reads those three through optional members, so a synthetic adapter that
  // omits them keeps today's fallback instead of reading this machine. The
  // adapter still answers them itself, as it did before the move.
  for (const name of ["hostLoad", "worktreeValidation", "hostProcessListing"])
    assert.equal(typeof (MachinePorts.prototype as unknown as Record<string, unknown>)[name], "function", `${name} answers on the prototype`);
  const load = adapter().hostLoad();
  assert.equal(typeof load.load, "number");
  assert.equal(typeof load.cpus, "number");
});

test("the scratch policy reads the adapter's run placement and repository namespace at call time", () => {
  const machine = adapter();
  const mount = "/Volumes/example-volume/scratch-fixture";
  machine.runScratch = checkoutRunScratchPlacement({ mount });
  assert.equal(machine.runTemporaryDirectory("run-1"), runTemporaryDirectory("run-1", runScratchRoot(mount)));
  machine.scratchNamespaceFor = () => "example-repo";
  assert.equal(machine.runTemporaryDirectory("run-1", task()), runTemporaryDirectory("run-1", runScratchRoot(mount, "example-repo")));
});
