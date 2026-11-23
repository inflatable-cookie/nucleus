import { hookHoldReason, isRecoveredPreDispatchHookHold } from "../hooks/hooks";
import {
  dispositionWorkPolicy,
  type Task,
  type TaskControlInput,
} from "../../shared/contracts";
import { archiveIntentUnreadable } from "../workspaces/archive-intent";
import { terminalArchiveWorkspaces } from "../closeout/terminal-archive";
import { cleanupTerminalBranches } from "../closeout/branch-cleanup";
import { archiveUnusedWorkspace } from "../workspaces/unused-workspace";
import { progressDisposition, reopenDispositionWorkspace } from "./disposition";
import { canRetireCancelledWorkspace } from "../workspaces/terminal-workspace-retirement";
import type { Engine } from "../engine";
import { blockingRecoveryEffects } from "../recovery/recovery-effects";
import { digest } from "../store/store";
import {
  collectOwnerVerbFacts,
  ownerEffectIdentity,
  ownerPendingEffects,
  type OwnerEffect,
} from "./owner-verbs";

/** One rule of the ordered chain that answers before observed-idle settlement. */
type BeforeSettlementRule = {
  /** Why the rule must run before any fence settlement, in one line. */
  name: string;
  /** The answer this rule owns, or null when the selected effect is not its subject. */
  run: (context: BeforeSettlementContext) => Promise<Task> | null;
};

type BeforeSettlementContext = {
  task: Task;
  input: TaskControlInput;
  effects: OwnerEffect[];
  selected: string | null;
  retries: OrdinaryEffectRetries;
};

/**
 * The ordered precondition chain. A flat switch would lose this order: a
 * publication must observe its original result before any fence settlement, a
 * later archive authority must not rewrite the original disposition, and only
 * an occurrence that actually exists may be retried.
 */
const BEFORE_SETTLEMENT: BeforeSettlementRule[] = [
  {
    name: "publication observes the original result before any settlement",
    run: ({ task, input, effects, selected, retries }) => {
      // A mismatch or unavailable inventory leaves the owner stop and findings
      // untouched; successful reconciliation settles attention in its commit.
      const publication = effects.find(
        (effect) =>
          effect.effect === selected && effect.kind === "review_publication",
      );
      return publication
        ? retries.retryPublicationBeforeSettlement(task, input, publication)
        : null;
    },
  },
  {
    name: "a cancelled workspace retires only on fresh owner authority",
    run: ({ task, input, effects, selected, retries }) => {
      // Later archive authority must not rewrite the original disposition or
      // settle unrelated episode history. Check it before any mutation.
      if (
        !canRetireCancelledWorkspace(task) ||
        selected !== `workspace_archive.${task.workspaceId}`
      )
        return null;
      return retries.engine.retryCancelledWorkspaceRetirement(task, input);
    },
  },
  {
    name: "a terminal workspace archive joins its own cleanup occurrence",
    run: ({ task, input, effects, selected, retries }) => {
      const terminal = terminalArchiveWorkspaces(
        task,
        retries.engine.store.runs(task.id),
      ).find((workspace) => selected === `workspace_archive.${workspace.id}`);
      if (
        !terminal?.id ||
        !effects.some((effect) => effect.effect === selected)
      )
        return null;
      return retries.engine.retryTerminalArchive(
        task,
        input,
        terminal.id,
        terminal.directory,
      );
    },
  },
  {
    name: "a recorded archive intent is observed, never re-sent",
    run: ({ task, input, effects, selected, retries }) => {
      // A recorded archive intent outside the terminal archive is an ordinary
      // retry on the cleanup lane. No owner content discard applies. A recorded
      // intent, readable or not, is offered so the owner can ask for the
      // observation and hear what the catalog answers.
      const runs = retries.engine.store.runs(task.id);
      const viewWorkspaceId = selected
        ? ownerEffectIdentity(selected, "workspace_archive")
        : null;
      const intentWorkspaceId =
        viewWorkspaceId &&
        (task.resolution.archiveIntentWorkspaceId === viewWorkspaceId ||
          archiveIntentUnreadable(task, runs) === viewWorkspaceId)
          ? viewWorkspaceId
          : null;
      if (
        !intentWorkspaceId ||
        !effects.some((effect) => effect.effect === selected)
      )
        return null;
      return retries.engine.retrySupersededReviewView(
        task,
        input,
        intentWorkspaceId,
      );
    },
  },
];

/**
 * The ordinary half of `retry_effect`: the branches that answer before
 * observed-idle settlement, and the final settlement of one named effect kind.
 * The effect key is decoded once into its kind and identity.
 */
export class OrdinaryEffectRetries {
  constructor(readonly engine: Engine) {}
  get store() {
    return this.engine.store;
  }
  get adapter() {
    return this.engine.adapter;
  }
  get resolution() {
    return this.engine.resolution;
  }

  /** The branches that answer before observed-idle settlement, on purpose. Not `async`: a fall-through settles in the same synchronous run. */
  retryEffectBeforeSettlement(
    task: Task,
    input: TaskControlInput,
  ): Promise<Task> | null {
    const effects = ownerPendingEffects(
      collectOwnerVerbFacts(this.store, task),
    );
    const selected =
      input.effect ?? (effects.length === 1 ? effects[0]!.effect : null);
    const context: BeforeSettlementContext = {
      task,
      input,
      effects,
      selected,
      retries: this,
    };
    for (const rule of BEFORE_SETTLEMENT) {
      const answer = rule.run(context);
      if (answer) return answer;
    }
    return null;
  }

  async retryPublicationBeforeSettlement(
    task: Task,
    input: TaskControlInput,
    publication: OwnerEffect,
  ): Promise<Task> {
    // Round 4: publishing is an immediate external effect. While Queue is
    // paused or the task held, the retry is recorded and applied once that
    // clears, rather than refused.
    const wait = this.engine.dispatchWaitsFor(task);
    if (wait && !this.engine.replayingDeferredVerb.getStore())
      return this.engine.deferOwnerVerb(
        task,
        { ...input, effect: publication.effect },
        wait,
        null,
      );
    this.engine.rejectFenced(task, "formal review publication reconciliation");
    const result = await this.resolution.reconcileReviewPublication(
      task,
      ownerEffectIdentity(publication.effect, "review_publication")!,
      input.reason ?? "",
      this.engine.coordinatorActionRunId.getStore(),
    );
    void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
    return result;
  }

  async retryOrdinaryEffect(
    task: Task,
    input: TaskControlInput,
    found: OwnerEffect,
    current: Task,
    expected: number,
  ): Promise<Task> {
    if (found.kind === "disposition_workspace") {
      // Spec 050: one explicit owner retry of a disposition that stopped at its
      // workspace proof or archive. The store derives the effect identity; the
      // original supersession or cancellation keeps its recorded kind,
      // replacement link, reason and every effect result. Selecting the safe
      // archive_if_empty policy is the one owner choice this verb adds, and it
      // is recorded with its authority before any proof or archive runs.
      const workspaceId = ownerEffectIdentity(
        found.effect,
        "disposition_workspace",
      )!;
      const disposition = current.disposition;
      if (!disposition || disposition.status !== "needs_attention")
        throw Error("The disposition is not waiting on a workspace step");
      const selected = input.workDisposition ?? null;
      const by =
        input.caller ?? (input.relayed ? "relayed owner" : "operator control");
      let authority: { kind: string; note: string | null } = {
        kind: "operator",
        note: null,
      };
      if (selected && selected !== dispositionWorkPolicy(disposition)) {
        if (selected !== "archive_if_empty")
          throw Error(
            "A disposition workspace recovery can only select the existing archive_if_empty policy",
          );
        const proven = this.engine.assertOwnerAuthority(
          input.caller,
          input.relayed,
          input.note,
          "Disposition proof policy selection",
        );
        authority = { kind: proven.kind, note: proven.note };
      }
      reopenDispositionWorkspace(this.store, {
        taskId: task.id,
        version: expected,
        workspaceId,
        policy: selected,
        reason: input.reason ?? "",
        by,
        authority,
      });
      const reopenedAt = this.store.task(task.id).version;
      const progressed = await progressDisposition(
        this.store,
        this.engine.dispositionDeps(),
        task.id,
      );
      this.store.event(
        task.id,
        "disposition_workspace_retry_result",
        JSON.stringify({
          workspaceId,
          policy: selected ?? dispositionWorkPolicy(disposition),
          status: progressed.disposition?.status ?? null,
          phase: progressed.phase,
          reopenedAt,
        }),
      );
      return progressed;
    }
    const identity = ownerEffectIdentity(found.effect, found.kind);
    switch (found.kind) {
      case "hook": {
        const result = await this.engine.hooks.retry(
          current,
          identity!,
          input.discard === true,
        );
        if (result.hold) throw Error(hookHoldReason(result));
        const latest = this.store.task(task.id);
        const { recovery, stop } = latest.resolution;
        if (
          ["done", "cancelled"].includes(latest.phase) &&
          stop?.reason === "operator_needed" &&
          recovery?.status === "resolved" &&
          recovery.key === digest(`stop:${stop.reason}:${stop.since}`) &&
          !blockingRecoveryEffects(this.store, latest, { noticeKinds: "all" }).length
        )
          return this.resolution.update(
            latest,
            { stop: null },
            {},
            "finished_hook_retry_cleared_recovery_stop",
            identity!,
          );
        return isRecoveredPreDispatchHookHold(latest, result)
          ? this.store.update(
              latest.id,
              { phase: "queued", reason: "Repository pre-dispatch hooks settled after retry" },
              "hook_retry_recovered",
            )
          : latest;
      }
      case "workspace_creation":
        return this.engine.retryValidation({
          taskId: task.id,
          version: expected,
          removeOrphanWorkspace: input.discard === true,
        });
      case "workspace_archive":
        return archiveUnusedWorkspace(
          this.store,
          this.adapter,
          { taskId: task.id, version: expected, unusedWorkspaceId: identity! },
          () => !this.engine.stopped,
          this.engine.retirement,
          (target) =>
            this.engine.retentionHold(
              task.id,
              target,
              "Unused workspace cleanup",
            ),
        );
      case "external_workspace_archive": {
        // Spec 017: one catalog-only retry on the existing cleanup lane. Pause
        // holds it like every other archive; the pass re-proves placement,
        // membership and idleness, observes an unknown prior answer and records
        // the outcome this call reports.
        const workspaceId = identity!;
        if (this.store.getMeta("paused") === true)
          throw Error(
            "Nucleus is paused; the external workspace catalog archive waits for the pause to clear",
          );
        this.engine.enqueueCleanup(task.id, workspaceId);
        await this.engine.awaitProjectionOccurrence(
          `cleanup:${task.id}:${workspaceId}`,
          () => this.engine.drainCleanup(),
        );
        const settled = this.store.task(task.id);
        const record = settled.resolution.externalWorkspaceArchives.find(
          (item) => item.workspaceId === workspaceId,
        );
        if (record?.state === "archived") return settled;
        throw Error(
          record
            ? `External workspace catalog archive for ${workspaceId} is ${record.state}: ${record.detail || "no cause was recorded"}`
            : `No catalog archive is pending for workspace ${workspaceId}`,
        );
      }
      case "runtime_retirement":
        return this.engine.retryRuntimeRetirement(task.id, expected);
      case "build_output_cleanup":
        return this.engine.retryBuildOutputCleanup(task.id, expected);
      case "merged_task_retention": {
        const outcome = await this.engine.hooks.retryRetentionAtIntegrationBase(
          current,
          input.reason ?? "",
        );
        let settled = this.store.task(task.id);
        if (!outcome.hold)
          this.engine.lifecycle.retentionReconciled(
            settled.id,
            settled.workspaceId,
          );
        settled = this.store.task(task.id);
        return settled;
      }
      case "branch_cleanup": {
        // nucleus#1548: observe the branch again and re-prove every safety rule
        // before deleting. The recorded deadline is the automatic path; an owner
        // retry is the explicit exit and reports what the attempt observed.
        const branch = identity!;
        const settled = await cleanupTerminalBranches(
          { store: this.store, adapter: this.adapter },
          task.id,
          { retry: true },
        );
        const record = settled.resolution.branchCleanups.find(
          (item) => item.branch === branch,
        );
        if (record && (record.state === "deleted" || record.state === "kept"))
          return settled;
        throw Error(
          record
            ? `Branch ${branch} cleanup is ${record.state}: ${record.detail || "no cause was recorded"}`
            : `No branch cleanup is pending for ${branch}`,
        );
      }
      case "review_publication":
        return this.retryPublicationBeforeSettlement(current, input, found);
      case "planning_base":
        return this.engine.rerecordPlanningBase({
          taskId: task.id,
          version: expected,
        });
      case "owned_tool":
      case "recovery_effect":
        if (found.effect === "project-validation.project-validation") {
          const resumed = this.resolution.retryProjectValidationEffect(current);
          void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
          return resumed;
        }
        throw Error(`Use record.clear kind=effect id=${found.effect}`);
    }
  }
}
