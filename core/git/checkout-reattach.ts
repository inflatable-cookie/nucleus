/**
 * The one reattach step for a task checkout a review round left detached
 * (Spec 068 §4). It never moves the commit: the task branch is checked out only
 * when no unreleased review round owns the checkout, the tree is clean and HEAD
 * already equals the branch tip. Everything else is refused by name and the
 * checkout is left exactly as it is, so a stuck state always has a visible
 * cause and an exit (`run.release`, then `run.start`).
 *
 * Callers: any launch into the task checkout, `run.start` and `run.release`,
 * and the verdict paths that restore an ordinary round's checkout.
 */
import { existsSync } from "node:fs";
import type { Run, Task } from "../../shared/contracts";
import { queueCheckoutStatus, returnCheckoutToBranch } from "./git-checkout";
import { GitIdentityError, readGitCheckout, readGitRef } from "./git-identity";

/** The terminal statuses a released round keeps; anything else still owns its round. */
const SETTLED_STATUSES = ["finished", "superseded"];

/**
 * A review round that still owns the task checkout: its round is unreleased or
 * unfinished, so its reader may still be reading this exact checkout.
 */
function ownsDetachedCheckout(
  run: Run,
  settlingRunId: string | undefined,
): boolean {
  return (
    run.ordinaryDetached === true &&
    run.id !== settlingRunId &&
    (!run.released || !SETTLED_STATUSES.includes(run.status))
  );
}

export type CheckoutReattach =
  /** There is no task checkout to reattach. */
  | { kind: "not-applicable"; reason: string }
  /** The checkout was already on the task branch. */
  | { kind: "attached"; branch: string; head: string }
  /** The checkout was detached at the branch tip and now carries the branch. */
  | { kind: "reattached"; branch: string; head: string }
  /** The checkout is detached and was left alone; the reason names why. */
  | { kind: "refused"; reason: string };

export interface ReattachOptions {
  /** The run this step settles; its own round is not treated as a foreign owner. */
  settlingRunId?: string;
  /** Durable visibility for an attempt that changed or refused something. */
  record?: (event: string, detail: string) => void;
}

const RECORDED = new Set<CheckoutReattach["kind"]>(["reattached", "refused"]);

function settle(
  result: CheckoutReattach,
  options: ReattachOptions,
): CheckoutReattach {
  if (!options.record || !RECORDED.has(result.kind)) return result;
  const detail =
    result.kind === "reattached"
      ? `${result.branch} at ${result.head}: HEAD already equalled the branch tip and the tree was clean, so the checkout carries its branch again and no commit moved`
      : result.kind === "refused"
        ? `${result.reason}. The checkout was left as it is`
        : "";
  if (!detail) return result;
  options.record(
    result.kind === "reattached"
      ? "task_checkout_reattached"
      : "task_checkout_reattach_refused",
    detail,
  );
  return result;
}

const refuse = (reason: string): CheckoutReattach => ({
  kind: "refused",
  reason,
});

/**
 * Return a detached task checkout to its task branch, or name why it stays
 * detached. Safe to call before every launch: a checkout already on its branch
 * costs one filesystem read and no git spawn.
 */
export async function reattachTaskCheckout(
  task: Task,
  runs: readonly Run[],
  options: ReattachOptions = {},
): Promise<CheckoutReattach> {
  if (!task.directory)
    return { kind: "not-applicable", reason: "the task has no checkout" };
  if (!existsSync(task.directory))
    return {
      kind: "not-applicable",
      reason: `the task checkout path ${task.directory} is absent`,
    };
  if (task.proofOnly || task.entrypoint === "proof")
    return {
      kind: "not-applicable",
      reason: "a proof-only checkout is detached at its immutable proof commit by design",
    };
  if (!task.branch || task.branch === task.baseBranch)
    return {
      kind: "not-applicable",
      reason: `the task records no branch of its own to return to`,
    };
  let checkout;
  try {
    checkout = readGitCheckout(task.directory);
  } catch (error) {
    return settle(
      refuse(
        error instanceof GitIdentityError
          ? `the task checkout identity could not be read (${error.code}): ${error.message}`
          : `the task checkout identity could not be read: ${String(error)}`,
      ),
      options,
    );
  }
  if (checkout.branch === task.branch)
    return { kind: "attached", branch: checkout.branch, head: checkout.head };
  if (checkout.branch !== "")
    return {
      kind: "not-applicable",
      reason: `the task checkout is on ${checkout.branch}, not detached`,
    };
  const owner = runs.find((run) =>
    ownsDetachedCheckout(run, options.settlingRunId),
  );
  if (owner)
    return settle(
      refuse(
        `the detached checkout is owned by unreleased review round ${owner.id} at ${owner.head}`,
      ),
      options,
    );
  const dirty = await queueCheckoutStatus(
    task.directory,
    "status",
    "--porcelain",
  );
  if (dirty)
    return settle(
      refuse(
        `the detached checkout has uncommitted changes: ${dirty.slice(0, 1000)}`,
      ),
      options,
    );
  let branchTip: string;
  try {
    branchTip = readGitRef(checkout, `refs/heads/${task.branch}`);
  } catch (error) {
    return settle(
      refuse(`branch ${task.branch} could not be read: ${String(error)}`),
      options,
    );
  }
  if (checkout.head !== branchTip)
    return settle(
      refuse(
        `the checkout is detached at ${checkout.head}, which is not the tip of ${task.branch} (${branchTip}); reattaching would move the working tree`,
      ),
      options,
    );
  try {
    await returnCheckoutToBranch(task.directory, task.branch, branchTip);
  } catch (error) {
    return settle(
      refuse(
        `returning the checkout to ${task.branch} failed: ${String(error)}`,
      ),
      options,
    );
  }
  let attached;
  try {
    attached = readGitCheckout(task.directory);
  } catch (error) {
    return settle(
      refuse(
        `the reattached checkout could not be read back: ${String(error)}`,
      ),
      options,
    );
  }
  if (attached.branch !== task.branch || attached.head !== branchTip)
    return settle(
      refuse(
        `the checkout did not return to ${task.branch} at ${branchTip}: observed ${attached.head} on ${attached.branch || "(detached)"}`,
      ),
      options,
    );
  return settle(
    { kind: "reattached", branch: attached.branch, head: attached.head },
    options,
  );
}

/** The refusal text a launch or guard reports when the checkout stays detached. */
export function reattachRefusal(result: CheckoutReattach): string | null {
  return result.kind === "refused" ? result.reason : null;
}
