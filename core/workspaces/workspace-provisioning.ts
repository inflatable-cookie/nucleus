import type { Task, WorktreeLinks } from "../../shared/contracts";
import { worktreeLinksSchema } from "../../shared/contracts";
import {
  refreshCheckoutSiblings as inspectWorktreeRootSiblings,
  worktreeRootFor,
} from "./checkout-siblings";
import type { Engine } from "../engine";
import { siblingStoreRootFor } from "../store/sibling-store";
import {
  createSiblingWorktrees,
  ensureSharedSiblingCheckouts,
  findingFor,
  inspectSiblingWorktrees,
  removeSiblingWorktrees,
  siblingIdentity,
  siblingMembers,
  siblingsEnabled,
} from "./siblings";
import { now } from "../store/store";
import { CheckoutUnavailableError } from "./checkout-volume";
import {
  bbWorktreeLinksWait,
  canonicalLinkRoot,
  provisionWorktreeLinks,
  worktreeLinksDue,
  worktreeLinksSummary,
} from "./worktree-links";

/**
 * What a task's checkout gets beside it before its worker runs: sibling
 * worktrees, checkout sibling refresh, links-only provisioning and the stash
 * baseline read. Same-name `Engine` methods delegate here. The getters read the
 * engine per call: tests replace the adapter, and the runtime owner sets
 * `siblingDataDir` after construction.
 */
export class WorkspaceProvisioning {
  constructor(readonly engine: Engine) {}
  get store() {
    return this.engine.store;
  }
  get adapter() {
    return this.engine.adapter;
  }
  get siblingDataDir() {
    return this.engine.siblingDataDir;
  }
  /**
   * Spec 027: ensure a task's sibling worktrees exist before its worker runs.
   * Intent is recorded first; an uncertain creation (intent without pins)
   * reconciles by path and commit inside creation and is never recreated
   * blindly. A single-repository project, an opt-out or a missing data
   * directory needs none. Per-member failures degrade to skipped members in
   * the creation event; only a systemic failure parks dispatch.
   */
  async ensureSiblings(task: Task): Promise<Task> {
    const current = this.store.task(task.id);
    if (
      !siblingsEnabled(current) ||
      !this.siblingDataDir ||
      (current.siblingPins.length && !current.hostId?.startsWith("bb:"))
    )
      return current;
    const members = siblingMembers(
      current,
      this.store.projectFor(current.repoPath, current.repository),
    ).filter(
      (member) =>
        !current.siblingPins.some(
          (pin) => pin.repository === siblingIdentity(member),
        ),
    );
    if (!members.length) return current;
    if (!current.siblingIntent)
      this.store.update(
        current.id,
        { siblingIntent: true },
        "sibling_worktrees_intent",
        `${members.length} sibling worktree(s) for project ${this.store.projectFor(current.repoPath, current.repository)?.key ?? "unknown"}`,
      );
    const { pins, skipped } = await createSiblingWorktrees({
      dataDir: this.siblingDataDir,
      taskId: current.id,
      baseBranch: current.baseBranch,
      members,
    });
    const detail = pins.length
      ? pins
          .map((pin) => `${pin.repository}@${pin.commit.slice(0, 12)}`)
          .join(", ")
      : "none created";
    return this.store.update(
      current.id,
      { siblingPins: [...current.siblingPins, ...pins], siblingIntent: false },
      "sibling_worktrees_created",
      skipped.length
        ? `${detail}; skipped ${skipped.map((skip) => `${skip.repository} (${skip.reason})`).join("; ")}`
        : detail,
    );
  }
  /** Remove a task's sibling worktrees with the task's own. Best effort: a
   * missing root or checkout is not a cleanup failure and operator checkouts
   * are never touched. */
  async removeSiblings(taskId: string): Promise<void> {
    if (!this.siblingDataDir) return;
    try {
      await removeSiblingWorktrees(this.siblingDataDir, taskId);
    } catch {
      /* sibling cleanup never fails task cleanup */
    }
  }
  /**
   * Spec 027: at each completion compare every sibling worktree with its
   * recorded commit. A moved head, a new commit or dirty files becomes a
   * sibling-change finding in task detail and in the reviewer's input;
   * nothing from a sibling is merged or pushed. Once per completion.
   */
  async compareSiblings(task: Task, eventId: string): Promise<Task> {
    const current = this.store.task(task.id);
    if (!current.siblingPins.length || !this.siblingDataDir) return current;
    if (
      this.store
        .events(current.id)
        .some((event) => event.kind === `sibling_compared:${eventId}`)
    )
      return current;
    const at = now();
    const fresh = (await inspectSiblingWorktrees(current.siblingPins))
      .map((inspection) => findingFor(inspection, at))
      .filter((finding): finding is NonNullable<typeof finding> =>
        Boolean(finding),
      )
      .filter(
        (finding) =>
          !current.siblingFindings.some(
            (existing) =>
              existing.repository === finding.repository &&
              existing.expected === finding.expected &&
              existing.actual === finding.actual &&
              existing.dirty === finding.dirty,
          ),
      );
    if (!fresh.length) {
      this.store.event(
        current.id,
        `sibling_compared:${eventId}`,
        "Sibling worktrees unchanged at their recorded commits",
      );
      return this.store.task(current.id);
    }
    return this.store.update(
      current.id,
      { siblingFindings: [...current.siblingFindings, ...fresh] },
      `sibling_compared:${eventId}`,
      `Sibling change: ${fresh.map((finding) => `${finding.repository} expected ${finding.expected.slice(0, 12)}, observed ${finding.actual?.slice(0, 12) ?? "missing"}${finding.dirty ? ", dirty" : ""}`).join("; ")}`,
    );
  }
  /**
   * Spec 028: fetch and fast-forward clean detached sibling checkouts in the
   * Paseo worktree root. Dirty, branched or diverged checkouts become findings
   * and are never moved. Failures never block dispatch.
   */
  async refreshCheckoutSiblings(
    task: Task,
    cause: "worker_creation" | "prerequisite_release",
  ): Promise<Task> {
    try {
      const current = this.store.task(task.id);
      const root = worktreeRootFor(current, this.store.activeCapacityTasks());
      if (!root) return current;
      const result = await inspectWorktreeRootSiblings(
        root,
        current.directory,
        this.siblingDataDir
          ? { storeDir: siblingStoreRootFor(this.siblingDataDir) }
          : undefined,
      );
      for (const forward of result.forwarded)
        this.store.event(
          current.id,
          "checkout_sibling_fast_forwarded",
          `${forward.name} ${forward.from} → ${forward.to} (${cause})`,
        );
      for (const share of result.shared)
        this.store.event(
          current.id,
          "checkout_sibling_shared",
          `${share.name} shares ${share.store} at ${share.head} (${cause})`,
        );
      const previous = current.checkoutSiblingFindings ?? [];
      const same =
        JSON.stringify(previous.map(({ at: _at, ...rest }) => rest)) ===
        JSON.stringify(result.findings.map(({ at: _at, ...rest }) => rest));
      if (same && !result.forwarded.length && !result.shared.length)
        return this.store.task(current.id);
      const counts = [
        result.forwarded.length
          ? `${result.forwarded.length} fast-forwarded`
          : "",
        result.shared.length ? `${result.shared.length} shared` : "",
      ]
        .filter(Boolean)
        .join(", ");
      const detail = result.findings.length
        ? result.findings.map((finding) => finding.detail).join("; ")
        : counts || "none";
      return this.store.update(
        current.id,
        { checkoutSiblingFindings: result.findings },
        "checkout_sibling_refresh",
        `${cause}: ${detail}`,
      );
    } catch (error) {
      this.store.event(
        task.id,
        "checkout_sibling_refresh_failed",
        `${cause}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.store.task(task.id);
    }
  }
  /**
   * Links-only provisioning (Tom, 2026-10-23): the first worker of a new
   * checkout gets the sibling links its `nucleus worktree prepare` call and the
   * primary's Effigy ledger declare. Other hosts keep non-blocking findings;
   * BB retries a failed pre-worker placement and waits on unresolved links.
   */
  async prepareWorktreeLinks(
    task: Task,
  ): Promise<{ task: Task; recordFailure: string | null }> {
    const current = this.store.task(task.id);
    const configured = [
      ...this.store.repositories().map((row) => row.repository),
      ...this.store.projects().flatMap((project) => project.repositories),
    ];
    const existingWait = worktreeLinksDue(current)
      ? null
      : await bbWorktreeLinksWait(current, configured);
    const previousAt =
      current.worktreeLinks?.state === "prepared"
        ? current.worktreeLinks.at
        : null;
    const retry = Boolean(
      existingWait &&
        current.hostId?.startsWith("bb:") &&
        current.worktreeLinks?.state === "prepared" &&
        current.worktreeLinks.workspaceId === current.workspaceId &&
        current.worktreeLinks.directory === current.directory &&
        !current.agentIntent &&
        !current.agentId &&
        !current.runId &&
        !current.retiredWorkers.length &&
        !current.continuesWorkspace,
    );
    if (existingWait && !retry)
      throw new CheckoutUnavailableError(existingWait);
    if (
      current.hostId?.startsWith("bb:") &&
      (worktreeLinksDue(current) || retry) &&
      !this.siblingDataDir
    )
      throw new CheckoutUnavailableError(
        "BB sibling provisioning waits: the sibling data directory is unavailable",
      );
    if (!this.siblingDataDir || (!worktreeLinksDue(current) && !retry))
      return { task: current, recordFailure: null };
    // An unexpected failure becomes the record's finding.
    const dataDir = this.siblingDataDir;
    const bb = current.hostId?.startsWith("bb:") && siblingsEnabled(current);
    const result = await (async () =>
      provisionWorktreeLinks({
        dataDir,
        task: current,
        configured,
        ...(bb
          ? {
              pinned: {
                taskId: current.id,
                pins: current.siblingPins,
                required: siblingMembers(
                  current,
                  this.store.projectFor(current.repoPath, current.repository),
                ),
              },
            }
          : {}),
      }))().catch((error) => ({
      state: "prepared" as const,
      workspaceId: current.workspaceId!,
      directory: current.directory!,
      commit: null,
      links: [],
      findings: [
        {
          kind: "manifest_invalid" as const,
          name: null,
          detail:
            `Links-only provisioning failed: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              2000,
            ),
        },
      ],
    }));
    try {
      const prepared = this.store.transaction(() => {
        const latest = this.store.task(current.id);
        if (
          (!worktreeLinksDue(latest) &&
            !(
              retry &&
              !latest.agentIntent &&
              !latest.agentId &&
              !latest.runId &&
              latest.worktreeLinks?.state === "prepared" &&
              latest.worktreeLinks.at === previousAt
            )) ||
          latest.workspaceId !== current.workspaceId ||
          latest.directory !== current.directory
        )
          return latest;
        let record: WorktreeLinks = { ...result, at: now() };
        // Backstop: a record outside the schema's bounds is never written as such.
        if (!worktreeLinksSchema.safeParse(record).success) {
          const placed = result.links
            .filter(
              (link) => link.outcome === "created" || link.outcome === "reused",
            )
            .map((link) => `../${link.name}`)
            .join(", ");
          record = {
            ...result,
            links: [],
            at: record.at,
            findings: [
              {
                kind: "manifest_invalid",
                name: null,
                detail:
                  `Per-link outcomes exceeded the record bounds and are not recorded.${placed ? ` Placed beside the checkout: ${placed}` : " No link was placed."}`.slice(
                    0,
                    2000,
                  ),
              },
            ],
          };
        }
        return this.store.update(
          latest.id,
          { worktreeLinks: record },
          "worktree_links_prepared",
          worktreeLinksSummary(record),
        );
      });
      const wait = await bbWorktreeLinksWait(prepared);
      if (wait) throw new CheckoutUnavailableError(wait);
      return { task: prepared, recordFailure: null };
    } catch (error) {
      if (error instanceof CheckoutUnavailableError) throw error;
      if (bb)
        throw new CheckoutUnavailableError(
          `BB sibling provisioning waits: link result could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
        );
      // The record stays pending (placement unknown, not success). The event is
      // best effort on a store that just failed; the prompt line comes from this
      // attempt's own failure. Every later store write keeps its ordinary failure.
      const recordFailure = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 500);
      try {
        this.store.event(
          current.id,
          "worktree_links_record_failed",
          recordFailure,
        );
      } catch {
        /* not claimed as recorded */
      }
      return { task: this.store.task(current.id), recordFailure };
    }
  }
  /** Legacy unqualified BB workspaces retain their shared-checkout behavior. */
  async ensureSharedSiblingCheckouts(task: Task): Promise<Task> {
    const current = this.store.task(task.id);
    // BB now uses the same declared-link placement as Paseo; creating shared
    // directories here would conflict with those links.
    if (
      current.hostId?.startsWith("bb:") ||
      this.adapter.vocabulary?.kind !== "bb" ||
      !current.directory ||
      !this.siblingDataDir
    )
      return current;
    const members = siblingMembers(
      current,
      this.store.projectFor(current.repoPath, current.repository),
    );
    if (!members.length) return current;
    let detail: string;
    try {
      const root = await canonicalLinkRoot(
        this.siblingDataDir,
        current.repoPath,
        current.directory,
      );
      detail = (
        await ensureSharedSiblingCheckouts({
          root,
          baseBranch: current.baseBranch,
          members,
        })
      )
        .map((outcome) => outcome.detail)
        .join("; ");
    } catch (error) {
      detail = `shared sibling checkouts failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      this.store.event(
        current.id,
        "shared_sibling_checkouts",
        detail.slice(0, 2000),
      );
    } catch {
      /* placement is not less true for an unwritable event */
    }
    return current;
  }
  /** Best effort: an unreadable stash list only loses the readiness comparison. */
  async readStash(directory: string) {
    try {
      return (await this.adapter.readStash?.(directory)) ?? null;
    } catch {
      return null;
    }
  }
}
