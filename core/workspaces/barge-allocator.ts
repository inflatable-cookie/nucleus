import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import type { Task } from "../../shared/schema/tasks";
import type {
  BargeReturnRecord,
  WorkspaceAllocation,
  WorkspaceProvider,
} from "../../shared/schema/workspace";
import { externalWorkspace } from "../../shared/workspace-ownership";
import { git } from "../git/index";
import {
  BargeCliError,
  bargeWorktreeLease,
  bargeWorktreeLeaseGet,
  bargeWorktreeReturn,
  classifyBargeDispatchError,
  formatBargeRequestId,
  type BargeClientOptions,
  type BargeWorktreeLease,
} from "./barge-cli";
import {
  BargeCustodyLostError,
  BargeUnsupportedCustodyError,
  releaseBargeCustodian,
  startBargeCustodian,
  verifyBargeCustodian,
} from "./barge-custodian";
import { CheckoutRefusalError, CheckoutUnavailableError } from "./checkout-volume";

const HEX_40_RE = /^[0-9a-f]{40}$/i;

export function isBargeTask(
  task: Pick<Task, "workspaceAllocation">,
): boolean {
  return task.workspaceAllocation?.provider === "barge";
}

export function chooseWorkspaceProvider(input: {
  task: Pick<
    Task,
    | "proofOnly"
    | "reviewEntry"
    | "workspaceOwnership"
    | "workspaceIntent"
    | "workspaceAllocation"
    | "workspaceId"
    | "directory"
    | "repoPath"
    | "repository"
  >;
  workspaceProviderFor: (
    task: Pick<Task, "repoPath" | "repository">,
  ) => WorkspaceProvider;
}): WorkspaceProvider {
  const { task, workspaceProviderFor } = input;
  if (task.proofOnly || externalWorkspace(task)) return "local";
  if (task.workspaceAllocation) return task.workspaceAllocation.provider;
  if (task.workspaceId || task.directory) return "local";
  return workspaceProviderFor(task);
}

export function nextAllocationSequence(
  task: Pick<Task, "workspaceAllocation" | "resolution">,
): number {
  const current = task.workspaceAllocation?.sequence ?? 0;
  const displacedMax = (task.resolution?.displacedWorkspaceAllocations ?? []).reduce(
    (max, entry) => Math.max(max, entry.sequence),
    0,
  );
  return Math.max(current, displacedMax, 0) + 1;
}

export async function resolveBargeRepoIdentifier(
  repoPath: string,
  repository?: string | null,
): Promise<string> {
  const origin = await git(repoPath, "remote", "get-url", "origin")
    .then((out: string) => out.trim())
    .catch(() => "");
  if (origin) return origin;
  if (repository?.trim()) {
    const slug = normalizeRepositoryOrigin(repository);
    if (slug) return `https://github.com/${slug}.git`;
  }
  return await realpath(repoPath).catch(() => resolve(repoPath));
}

export function createBargeAllocationIntent(input: {
  task: Pick<Task, "id" | "repoPath" | "baseBranch" | "branch">;
  sequence: number;
  baseSha: string;
  repoIdentifier?: string | null;
  branch?: string;
  baseBranch?: string;
  repoPath?: string;
}): WorkspaceAllocation {
  const timestamp = new Date().toISOString();
  return {
    provider: "barge",
    sequence: input.sequence,
    allocationId: `${input.task.id}:a${input.sequence}`,
    requestId: formatBargeRequestId("nuc", input.task.id, input.sequence),
    repoPath: input.repoPath ?? input.task.repoPath,
    repoIdentifier: input.repoIdentifier ?? null,
    baseBranch: input.baseBranch ?? input.task.baseBranch,
    baseSha: input.baseSha,
    branch: input.branch ?? input.task.branch,
    label: input.task.id,
    leaseId: null,
    pool: null,
    rootId: null,
    checkoutPath: null,
    gitCommonDir: null,
    state: "intent",
    custodian: null,
    returnRecord: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    error: null,
  };
}

export async function verifyLeasedBargeCheckout(input: {
  lease: BargeWorktreeLease;
  expectedRequestId: string;
  expectedBranch: string;
  expectedBaseSha: string;
  expectedRepositoryOrigin?: string | null;
}): Promise<{ checkoutPath: string; gitCommonDir: string }> {
  const { lease } = input;
  if (lease.request !== input.expectedRequestId) {
    throw new CheckoutRefusalError(
      `Barge lease ${lease.lease_id} request ${lease.request} does not match expected request ${input.expectedRequestId}`,
    );
  }
  if (lease.branch !== input.expectedBranch) {
    throw new CheckoutRefusalError(
      `Barge lease ${lease.lease_id} branch ${lease.branch} does not match expected branch ${input.expectedBranch}`,
    );
  }
  if (
    HEX_40_RE.test(input.expectedBaseSha) &&
    lease.base.toLowerCase() !== input.expectedBaseSha.toLowerCase()
  ) {
    throw new CheckoutRefusalError(
      `Barge lease ${lease.lease_id} base ${lease.base} does not match expected base ${input.expectedBaseSha}`,
    );
  }

  const dotGitStat = await lstat(join(lease.path, ".git")).catch(() => null);
  if (!dotGitStat || !dotGitStat.isFile()) {
    throw new CheckoutRefusalError(
      `Barge leased checkout ${lease.path} is missing a worktree .git file`,
    );
  }

  const checkoutPath = await realpath(lease.path);
  const toplevel = await realpath(
    await git(checkoutPath, "rev-parse", "--show-toplevel"),
  );
  if (toplevel !== checkoutPath) {
    throw new CheckoutRefusalError(
      `Barge leased path ${checkoutPath} does not match git toplevel ${toplevel}`,
    );
  }

  const gitCommonDir = resolve(
    await git(checkoutPath, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const head = (await git(checkoutPath, "rev-parse", "HEAD")).trim();
  if (head.toLowerCase() !== lease.base.toLowerCase()) {
    throw new CheckoutRefusalError(
      `Barge leased checkout ${checkoutPath} HEAD ${head} differs from leased base ${lease.base}`,
    );
  }

  const branch = (
    await git(checkoutPath, "rev-parse", "--abbrev-ref", "HEAD")
  ).trim();
  if (branch !== input.expectedBranch) {
    throw new CheckoutRefusalError(
      `Barge leased checkout ${checkoutPath} is on branch ${branch} instead of ${input.expectedBranch}`,
    );
  }

  const status = (await git(checkoutPath, "status", "--porcelain")).trim();
  if (status) {
    throw new CheckoutRefusalError(
      `Barge leased checkout ${checkoutPath} is not clean after leasing`,
    );
  }

  if (input.expectedRepositoryOrigin) {
    const expectedOrigin = normalizeRepositoryOrigin(input.expectedRepositoryOrigin);
    const originUrl = await git(checkoutPath, "remote", "get-url", "origin").catch(
      () => null,
    );
    if (expectedOrigin && originUrl) {
      const actualOrigin = normalizeRepositoryOrigin(originUrl);
      if (actualOrigin && actualOrigin !== expectedOrigin) {
        throw new CheckoutRefusalError(
          `Barge leased checkout ${checkoutPath} origin ${actualOrigin} differs from repository ${expectedOrigin}`,
        );
      }
    }
  }

  return { checkoutPath, gitCommonDir };
}

export async function provisionBargeAllocation(input: {
  allocation: WorkspaceAllocation;
  task: Pick<Task, "id" | "repoPath" | "repository" | "branch" | "baseBranch">;
  saveAllocation: (allocation: WorkspaceAllocation) => unknown;
  cliOptions?: BargeClientOptions;
  controlRootDir?: string;
}): Promise<WorkspaceAllocation> {
  let current = input.allocation;
  const requestId = current.requestId;
  if (!requestId) {
    throw new CheckoutRefusalError(
      `Barge allocation ${current.allocationId} lacks a persisted requestId`,
    );
  }
  const branch = current.branch ?? input.task.branch;
  const baseBranch = current.baseBranch ?? input.task.baseBranch;
  const baseSha = current.baseSha;
  if (!baseSha) {
    throw new CheckoutRefusalError(
      `Barge allocation ${current.allocationId} lacks a resolved base SHA`,
    );
  }

  const repoIdentifier =
    current.repoIdentifier ??
    (await resolveBargeRepoIdentifier(current.repoPath, input.task.repository));
  if (repoIdentifier !== current.repoIdentifier) {
    current = {
      ...current,
      repoIdentifier,
      updatedAt: new Date().toISOString(),
    };
    await input.saveAllocation(current);
  }

  let lease: BargeWorktreeLease | null = null;
  if (current.state === "uncertain" || current.leaseId) {
    try {
      lease = await bargeWorktreeLeaseGet(
        current.leaseId ? { leaseId: current.leaseId } : { request: requestId },
        input.cliOptions,
      );
    } catch (error) {
      if (!(error instanceof BargeCliError && error.kind === "not_found")) {
        throw classifyBargeDispatchError(error);
      }
    }
  }

  if (!lease) {
    try {
      lease = await bargeWorktreeLease(
        {
          repo: repoIdentifier,
          base: baseSha,
          branch,
          baseName: baseBranch,
          label: current.label ?? input.task.id,
          request: requestId,
        },
        input.cliOptions,
      );
    } catch (error) {
      if (error instanceof BargeCliError && error.uncertain) {
        current = {
          ...current,
          state: "uncertain",
          updatedAt: new Date().toISOString(),
          error: error.message,
        };
        await input.saveAllocation(current);

        try {
          lease = await bargeWorktreeLeaseGet(
            { request: requestId },
            input.cliOptions,
          );
        } catch (getError) {
          if (
            getError instanceof BargeCliError &&
            getError.kind === "not_found"
          ) {
            current = {
              ...current,
              state: "intent",
              updatedAt: new Date().toISOString(),
              error: `Barge lease reconciliation confirmed no allocation was created for request ${requestId}`,
            };
            await input.saveAllocation(current);
            throw new CheckoutUnavailableError(error.message);
          }
          throw classifyBargeDispatchError(getError);
        }
      } else {
        throw classifyBargeDispatchError(error);
      }
    }
  }

  if (lease.state !== "leased") {
    throw new CheckoutRefusalError(
      `Barge lease ${lease.lease_id} returned in non-leased state ${lease.state}`,
    );
  }

  const verified = await verifyLeasedBargeCheckout({
    lease,
    expectedRequestId: requestId,
    expectedBranch: branch,
    expectedBaseSha: baseSha,
    expectedRepositoryOrigin: input.task.repository,
  });

  // Record lease identity and checkout path durably BEFORE custodian start or native registration.
  current = {
    ...current,
    leaseId: lease.lease_id,
    pool: lease.pool,
    rootId: lease.root_id,
    checkoutPath: verified.checkoutPath,
    gitCommonDir: verified.gitCommonDir,
    state: "leased",
    updatedAt: new Date().toISOString(),
    error: null,
  };
  await input.saveAllocation(current);

  try {
    const custodian = await startBargeCustodian({
      allocationId: current.allocationId,
      leaseId: lease.lease_id,
      repoPath: current.repoIdentifier ?? current.repoPath,
      controlRootDir: input.controlRootDir,
      cliOptions: input.cliOptions,
    });
    current = {
      ...current,
      custodian,
      updatedAt: new Date().toISOString(),
      error: null,
    };
    await input.saveAllocation(current);
    return current;
  } catch (custodyError) {
    const message =
      custodyError instanceof Error
        ? custodyError.message
        : String(custodyError);

    // Custodian failed before native registration or agent start; return unused empty lease cleanly so pools are not leaked.
    try {
      const rollbackReq = formatBargeRequestId(
        "abort",
        input.task.id,
        current.sequence,
      );
      await bargeWorktreeReturn(
        { leaseId: lease.lease_id, request: rollbackReq, disposable: false },
        input.cliOptions,
      );
      current = {
        ...current,
        state: "returned",
        custodian: null,
        updatedAt: new Date().toISOString(),
        error: message,
      };
      await input.saveAllocation(current);
    } catch {
      current = {
        ...current,
        state: "lost",
        updatedAt: new Date().toISOString(),
        error: message,
      };
      await input.saveAllocation(current);
    }

    if (
      custodyError instanceof BargeUnsupportedCustodyError ||
      custodyError instanceof BargeCustodyLostError
    ) {
      throw new CheckoutRefusalError(message);
    }
    throw classifyBargeDispatchError(custodyError);
  }
}

export async function verifyBargeLeaseAndCustody(input: {
  allocation: WorkspaceAllocation;
  saveAllocation?: (allocation: WorkspaceAllocation) => unknown;
  cliOptions?: BargeClientOptions;
  requireHeldCustodian?: boolean;
}): Promise<WorkspaceAllocation> {
  const { allocation } = input;
  if (allocation.provider !== "barge" || !allocation.leaseId) {
    throw new CheckoutRefusalError(
      `Task allocation ${allocation.allocationId} does not hold an active Barge lease`,
    );
  }
  if (allocation.state === "lost" || allocation.custodian?.state === "lost") {
    throw new BargeCustodyLostError(
      allocation.custodian?.error ??
        allocation.error ??
        `Custody lost for Barge lease ${allocation.leaseId}`,
    );
  }
  if (allocation.state !== "leased") {
    throw new CheckoutRefusalError(
      `Barge allocation ${allocation.allocationId} is in state ${allocation.state}`,
    );
  }

  const lease = await bargeWorktreeLeaseGet(
    { leaseId: allocation.leaseId },
    input.cliOptions,
  );
  if (lease.state !== "leased" || lease.lease_id !== allocation.leaseId) {
    throw new CheckoutRefusalError(
      `Barge lease ${allocation.leaseId} is no longer active (observed state ${lease.state})`,
    );
  }
  if (allocation.checkoutPath) {
    const actualPath = await realpath(lease.path).catch(() => resolve(lease.path));
    const expectedPath = await realpath(allocation.checkoutPath).catch(() =>
      resolve(allocation.checkoutPath!),
    );
    if (actualPath !== expectedPath) {
      throw new CheckoutRefusalError(
        `Barge lease ${allocation.leaseId} path ${actualPath} does not match recorded path ${expectedPath}`,
      );
    }
  }

  if (input.requireHeldCustodian !== false) {
    const check = await verifyBargeCustodian(allocation, input.cliOptions);
    if (check.status === "lost") {
      const lost: WorkspaceAllocation = {
        ...allocation,
        state: "lost",
        custodian: check.custodian,
        updatedAt: check.checkedAt,
        error: check.reason ?? "Barge custody lost",
      };
      if (input.saveAllocation) await input.saveAllocation(lost);
      throw new BargeCustodyLostError(
        check.reason ?? `Custody lost for Barge lease ${allocation.leaseId}`,
      );
    }
    if (check.status === "holding" && input.saveAllocation) {
      const refreshed: WorkspaceAllocation = {
        ...allocation,
        custodian: check.custodian,
        updatedAt: check.checkedAt,
      };
      await input.saveAllocation(refreshed);
      return refreshed;
    }
  }

  return allocation;
}

export function hasReturnDisposableAuthorization(input: {
  task: Pick<Task, "resolution" | "disposition">;
  dispositionEvidence?: string | null;
  originPublished?: boolean;
}): { disposable: boolean; reason: string | null } {
  if (input.originPublished) {
    return { disposable: true, reason: "origin_published" };
  }
  if (
    input.task.resolution?.mergedCommit ||
    input.task.resolution?.syncedCommit ||
    input.task.resolution?.mergedWithNone
  ) {
    return { disposable: true, reason: "resolution_merged" };
  }
  if (input.task.resolution?.workspaceRetirement?.authorization) {
    return {
      disposable: true,
      reason: `workspace_retirement:${input.task.resolution.workspaceRetirement.authorization.kind}`,
    };
  }
  if (
    input.task.disposition?.kind === "cancel" ||
    input.task.disposition?.kind === "supersede"
  ) {
    return {
      disposable: true,
      reason: `disposition:${input.task.disposition.kind}`,
    };
  }
  if (input.dispositionEvidence?.trim()) {
    return { disposable: true, reason: input.dispositionEvidence.trim() };
  }
  return { disposable: false, reason: null };
}

export async function preserveBargeHeadForReplacement(input: {
  repoPath: string;
  oldCheckoutPath: string;
  expectedHead: string;
}): Promise<void> {
  const { repoPath, oldCheckoutPath, expectedHead } = input;
  const alreadyPresent = await git(
    repoPath,
    "cat-file",
    "-t",
    `${expectedHead}^{commit}`,
  )
    .then((out: string) => out.trim() === "commit")
    .catch(() => false);
  if (alreadyPresent) return;

  await git(repoPath, "fetch", "--no-tags", oldCheckoutPath, expectedHead);
  const fetched = await git(
    repoPath,
    "cat-file",
    "-t",
    `${expectedHead}^{commit}`,
  )
    .then((out: string) => out.trim() === "commit")
    .catch(() => false);
  if (!fetched) {
    throw new Error(
      `Replacement continuation head ${expectedHead} could not be preserved in ${repoPath} before returning old Barge lease`,
    );
  }
}

export async function returnBargeAllocation(input: {
  allocation: WorkspaceAllocation;
  task: Pick<Task, "id" | "resolution" | "disposition">;
  saveAllocation: (allocation: WorkspaceAllocation) => unknown;
  dispositionEvidence?: string | null;
  originPublished?: boolean;
  cliOptions?: BargeClientOptions;
}): Promise<{ status: "returned"; allocation: WorkspaceAllocation }> {
  let current = input.allocation;
  if (current.provider !== "barge") {
    return { status: "returned", allocation: current };
  }
  if (current.state === "returned") {
    return { status: "returned", allocation: current };
  }

  // Resolve uncertain initial allocation before declaring returned/fenced.
  if (!current.leaseId) {
    if (
      (current.state === "intent" || current.state === "uncertain") &&
      current.requestId
    ) {
      try {
        const lease = await bargeWorktreeLeaseGet(
          { request: current.requestId },
          input.cliOptions,
        );
        current = {
          ...current,
          leaseId: lease.lease_id,
          pool: lease.pool,
          rootId: lease.root_id,
          checkoutPath: lease.path,
          updatedAt: new Date().toISOString(),
        };
        await input.saveAllocation(current);
      } catch (error) {
        if (error instanceof BargeCliError && error.kind === "not_found") {
          current = {
            ...current,
            state: "returned",
            updatedAt: new Date().toISOString(),
            error: null,
          };
          await input.saveAllocation(current);
          return { status: "returned", allocation: current };
        }
        throw error;
      }
    } else {
      current = {
        ...current,
        state: "returned",
        updatedAt: new Date().toISOString(),
      };
      await input.saveAllocation(current);
      return { status: "returned", allocation: current };
    }
  }

  // Fence return if custody was lost mid-use before authorized quiescence.
  if (current.state === "lost" || current.custodian?.state === "lost") {
    throw new BargeCustodyLostError(
      current.custodian?.error ??
        current.error ??
        `Custody lost for Barge lease ${current.leaseId}; return remains fenced`,
    );
  }

  if (
    current.custodian &&
    ["starting", "holding"].includes(current.custodian.state)
  ) {
    try {
      const releasedCustodian = await releaseBargeCustodian(
        current,
        input.cliOptions,
      );
      current = {
        ...current,
        custodian: releasedCustodian,
        updatedAt: new Date().toISOString(),
      };
      await input.saveAllocation(current);
    } catch (error) {
      if (error instanceof BargeCustodyLostError) {
        current = {
          ...current,
          state: "lost",
          custodian: current.custodian
            ? {
                ...current.custodian,
                state: "lost",
                error: error.message,
              }
            : null,
          updatedAt: new Date().toISOString(),
          error: error.message,
        };
        await input.saveAllocation(current);
      }
      throw error;
    }
  }

  const lease = await bargeWorktreeLeaseGet(
    { leaseId: current.leaseId! },
    input.cliOptions,
  );
  if (lease.lease_id !== current.leaseId) {
    throw new CheckoutRefusalError(
      `Barge returned mismatched lease identity ${lease.lease_id} for ${current.leaseId}`,
    );
  }
  if (lease.state === "returned") {
    const now = new Date().toISOString();
    const record: BargeReturnRecord = current.returnRecord
      ? {
          ...current.returnRecord,
          state: "returned",
          updatedAt: now,
          returnedAt: current.returnRecord.returnedAt ?? now,
          lastError: null,
          lastErrorKind: null,
        }
      : {
          operationId: randomUUID(),
          requestId: formatBargeRequestId("ret", input.task.id, current.sequence, "r1"),
          state: "returned",
          disposable: false,
          dispositionEvidence: input.dispositionEvidence ?? null,
          attemptCount: 1,
          startedAt: now,
          updatedAt: now,
          returnedAt: now,
          lastError: null,
          lastErrorKind: null,
        };
    current = {
      ...current,
      state: "returned",
      returnRecord: record,
      updatedAt: now,
      error: null,
    };
    await input.saveAllocation(current);
    return { status: "returned", allocation: current };
  }

  const { disposable, reason } = hasReturnDisposableAuthorization({
    task: input.task,
    dispositionEvidence: input.dispositionEvidence,
    originPublished: input.originPublished,
  });

  const now = new Date().toISOString();
  const prevReturn = current.returnRecord;
  const reuseReturnIdentity =
    prevReturn &&
    ["intent", "uncertain", "interrupted"].includes(prevReturn.state) &&
    prevReturn.disposable === disposable;
  const attemptCount = (prevReturn?.attemptCount ?? 0) + 1;
  const returnRecord: BargeReturnRecord = reuseReturnIdentity
    ? {
        ...prevReturn,
        state: "intent",
        attemptCount,
        updatedAt: now,
        lastError: null,
        lastErrorKind: null,
      }
    : {
        operationId: randomUUID(),
        requestId: formatBargeRequestId(
          "ret",
          input.task.id,
          current.sequence,
          `r${attemptCount}`,
        ),
        state: "intent",
        disposable,
        dispositionEvidence: reason,
        attemptCount,
        startedAt: now,
        updatedAt: now,
        returnedAt: null,
        lastError: null,
        lastErrorKind: null,
      };

  current = {
    ...current,
    state: "returning",
    returnRecord,
    updatedAt: now,
    error: null,
  };
  await input.saveAllocation(current);

  try {
    await bargeWorktreeReturn(
      {
        leaseId: current.leaseId!,
        request: current.requestId ?? undefined,
        disposable,
      },
      input.cliOptions,
    );
    const completedAt = new Date().toISOString();
    current = {
      ...current,
      state: "returned",
      returnRecord: {
        ...returnRecord,
        state: "returned",
        updatedAt: completedAt,
        returnedAt: completedAt,
        lastError: null,
        lastErrorKind: null,
      },
      updatedAt: completedAt,
      error: null,
    };
    await input.saveAllocation(current);
    return { status: "returned", allocation: current };
  } catch (error) {
    const failedAt = new Date().toISOString();
    if (error instanceof BargeCliError) {
      if (error.uncertain) {
        try {
          const checked = await bargeWorktreeLeaseGet(
            { leaseId: current.leaseId! },
            input.cliOptions,
          );
          if (checked.state === "returned") {
            current = {
              ...current,
              state: "returned",
              returnRecord: {
                ...returnRecord,
                state: "returned",
                updatedAt: failedAt,
                returnedAt: failedAt,
                lastError: null,
                lastErrorKind: null,
              },
              updatedAt: failedAt,
              error: null,
            };
            await input.saveAllocation(current);
            return { status: "returned", allocation: current };
          }
          const nextState =
            checked.state === "interrupted" || checked.state === "returning"
              ? "interrupted"
              : "uncertain";
          current = {
            ...current,
            state: nextState === "interrupted" ? "interrupted" : "returning",
            returnRecord: {
              ...returnRecord,
              state: nextState,
              updatedAt: failedAt,
              lastError: error.message,
              lastErrorKind: error.kind,
            },
            updatedAt: failedAt,
            error: error.message,
          };
          await input.saveAllocation(current);
          throw error;
        } catch (reconcileError) {
          if (reconcileError !== error) {
            current = {
              ...current,
              state: "returning",
              returnRecord: {
                ...returnRecord,
                state: "uncertain",
                updatedAt: failedAt,
                lastError: error.message,
                lastErrorKind: error.kind,
              },
              updatedAt: failedAt,
              error: error.message,
            };
            await input.saveAllocation(current);
          }
          throw error;
        }
      }

      const interrupted = error.kind === "unknown_state";
      current = {
        ...current,
        state: interrupted ? "interrupted" : "leased",
        returnRecord: {
          ...returnRecord,
          state: interrupted ? "interrupted" : "refused",
          updatedAt: failedAt,
          lastError: error.message,
          lastErrorKind: error.kind,
        },
        updatedAt: failedAt,
        error: error.message,
      };
      await input.saveAllocation(current);
      throw error;
    }

    current = {
      ...current,
      state: "returning",
      returnRecord: {
        ...returnRecord,
        state: "uncertain",
        updatedAt: failedAt,
        lastError: error instanceof Error ? error.message : String(error),
        lastErrorKind: "io",
      },
      updatedAt: failedAt,
      error: error instanceof Error ? error.message : String(error),
    };
    await input.saveAllocation(current);
    throw error;
  }
}
