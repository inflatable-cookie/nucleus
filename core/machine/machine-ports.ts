import { cpus, loadavg } from "node:os";
import type { Task } from "../../shared/contracts";
import * as forge from "../forge/index";
import {
  validateDispatch, verifyWorkspace, verifyPr, verifyResume, verifyCheckpoint, verifyReplacementSource, verifyCleanQueueWorktree, readStash,
} from "../git/index";
import { checkoutRunScratchPlacement, runTemporaryDirectory, type RunScratchPlacement } from "../workspaces/run-scratch";
import { findWorktreeValidation, type WorktreeValidationScan } from "../workspaces/worktree-validation";
import { readHostUidProcesses } from "./host-process-listing";
import type { HostProcessFact } from "../host/types";

/**
 * The machine ports: work that belongs to the machine this daemon runs on, never
 * to an agent application.
 *
 * Step 3 row 2 of the Paseo host split map (task 871) moved these out of
 * `server/paseo.ts`, where the Paseo adapter carried them only because it was
 * the one object the core held. Nothing here reads Paseo, its daemon or its
 * SDK: Git and forge checks, the operator's validation and scratch policy, and
 * the two injected probes that observe host load and the host process table are
 * Nucleus's own.
 *
 * The adapter keeps the same members, unchanged and in the same place in its
 * prototype chain, by extending this class. A caller writes
 * `this.adapter.verifyPr(...)` exactly as before, an instance override
 * (`adapter.verifyPr = ...`, `adapter.runScratch = ...`) still wins, and the
 * optional members stay optional on `Adapter`, so a synthetic test adapter that
 * omits a probe still observes none instead of reading this machine.
 *
 * The pure Git and forge members are field initialisers, not methods, on
 * purpose: they are the core function references themselves, so a fixture may
 * read one off the adapter and hand it to another adapter, and a class that
 * stands in for the adapter without running its initialisers carries none of
 * them. The probes are methods, as they were.
 */
export class MachinePorts {
  validate = validateDispatch;
  verifyWorkspace = verifyWorkspace;
  verifyPr = verifyPr;
  verifyPrIdentity = forge.verifyPrIdentity;
  verifyInspectedRevisionHead = forge.verifyInspectedRevisionHead;
  verifyContinuedProgress = forge.verifyContinuedProgress;
  findOpenBranchPr = forge.findOpenBranchPr;
  findAnyOpenBranchPr = forge.findAnyOpenBranchPr;
  verifyCancelledWorkspacePr = forge.verifyCancelledWorkspacePr;
  verifyResume = verifyResume;
  verifyCheckpoint = verifyCheckpoint;
  verifyReplacementSource = verifyReplacementSource;
  verifyCleanQueueWorktree = verifyCleanQueueWorktree;
  readStash = readStash;

  publishReview = forge.publishReviewOnce;
  reconcileReviewPublication = forge.reconcileFormalReviewPublication;
  externalMerge = forge.externalMerge;
  mergeGate = forge.mergeGate;
  requiredChecks = forge.requiredChecks;
  coveringEvidence = forge.coveringEvidence;
  authorCommentEvidence = (t: Task, priorCommentId?: number | null) => forge.authorCommentEvidence(t, priorCommentId ?? null);
  rerunFailedWorkflowRuns = forge.rerunFailedWorkflowRuns;
  merge = forge.merge;
  merged = forge.merged;
  syncMain = forge.syncMain;
  verifyCloseout = forge.verifyCloseout;

  /** Where each Queue-launched run's own temp directory lives and how it is proved. */
  scratchNamespaceFor?: (task: Task) => string;
  /**
   * Where each Queue-launched run's own temp directory lives and how it is proved
   * (queue #535). The default proves the mounted checkout volume before creating it;
   * a private fixture supplies its own mount, never a weaker policy.
   */
  runScratch: RunScratchPlacement = checkoutRunScratchPlacement();
  protected scratchPlacement(task?: Task): RunScratchPlacement {
    const namespace = task && this.scratchNamespaceFor ? this.scratchNamespaceFor(task) : undefined;
    return namespace ? this.runScratch.withNamespace?.(namespace) ?? checkoutRunScratchPlacement({ namespace }) : this.runScratch;
  }
  runTemporaryDirectory(runId: string, task?: Task): string { return runTemporaryDirectory(runId, this.scratchPlacement(task).root); }

  hostLoad() { return { load: loadavg()[0], cpus: cpus().length }; }
  worktreeValidation(directory: string, extraArgv: string[][]): WorktreeValidationScan { return findWorktreeValidation(directory, extraArgv); }
  /** Complete host process table for proofs rooted in a Queue-launched provider. */
  async hostProcessListing(): Promise<HostProcessFact[] | null> {
    const read = await readHostUidProcesses();
    return read.state === "listed" ? read.processes : null;
  }
}
