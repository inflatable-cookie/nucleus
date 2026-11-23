import type {
  Task,
  TaskControlInput,
  WorkspaceArchiveRetry,
} from "../../shared/contracts";
import {
  archiveFinishedThreads,
  exhaustedThreadArchives,
} from "../workspaces/thread-archive";
import type { WorkspaceDiscard } from "../workspaces/orphan-worktree";
import { workspaceDiscardKey } from "../workspaces/orphan-worktree";
import {
  canRetireCancelledWorkspace,
  recordWorkspaceRetirement,
} from "../workspaces/terminal-workspace-retirement";
import type { Engine } from "../engine";
import { now } from "../store/store";

/**
 * A workspace's archive retry record is the evidence an attempt ran: a new
 * attempt rewrites its count, cause or deadline, while a held one leaves it
 * exactly as recorded. Its absence before and after is no attempt either.
 */
const archiveRetryRecordChanged = (
  before: WorkspaceArchiveRetry | null,
  after: WorkspaceArchiveRetry | null,
) =>
  before === null || after === null
    ? before !== after
    : after.attempts !== before.attempts ||
      after.error !== before.error ||
      after.nextAttemptAt !== before.nextAttemptAt;

/**
 * The archive half of `retry_effect`: the terminal workspace archive (with its
 * content-discard authority), a cancelled workspace's retirement, and the
 * superseded review view still on disk. Each observes the catalog or the cleanup
 * lane's own record before it reports what happened, and a pause holds every
 * attempt without touching the stored failure.
 */
export class ArchiveEffectRetries {
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

  async retryCancelledWorkspaceRetirement(
    task: Task,
    input: TaskControlInput,
  ): Promise<Task> {
    const authority = this.engine.assertOwnerAuthority(
      input.caller,
      input.relayed,
      input.note,
      "Workspace retirement",
    );
    // Papercut c7643943: an explicit content discard is the same durable owner
    // decision the done-task route records, bound to this exact task, workspace
    // and directory. It is persisted before the retirement preflight, and the
    // preflight and adapter then waive only the content and publication proofs
    // for it. Prose in the reason, a note or an older retirement authorization
    // is never read as authority to lose contents.
    if (input.discard === true)
      this.engine.recordWorkspaceDiscard(
        task,
        task.workspaceId!,
        task.directory!,
        input,
        authority,
      );
    const prior = task.resolution.workspaceRetirement;
    if (!prior || prior.state === "held")
      recordWorkspaceRetirement(this.store, task.id, {
        workspaceId: task.workspaceId!,
        directory: task.directory!,
        branch: task.branch,
        head: null,
        authorization: {
          caller: input.caller!,
          kind: authority.kind,
          note: authority.note,
          reason: input.reason!,
          at: now(),
        },
        state: "authorized",
        detail: "Owner authorized retirement of the preserved workspace",
        intentAt: null,
        archivedAt: null,
      });
    return this.engine.settleWorkspaceRetirement(task.id);
  }

  async retryTerminalArchive(
    task: Task,
    input: TaskControlInput,
    archiveWorkspaceId: string,
    directory: string | null | undefined,
  ): Promise<Task> {
    // Papercut c7643943: `discard` records the owner's durable decision to
    // lose this workspace's unproven contents, bound to the workspace and its
    // directory, before any archive effect. A replay keeps the first record.
    // The archive then waives only its content proofs; every fence stays.
    const priorDiscard =
      this.store.getMeta<WorkspaceDiscard>(
        workspaceDiscardKey(task.id, archiveWorkspaceId),
      ) ?? null;
    if (input.discard === true) {
      if (!directory)
        throw Error("A content discard needs the workspace directory it binds");
      const authority = this.engine.assertOwnerAuthority(
        input.caller,
        input.relayed,
        input.note,
        "Workspace content discard",
      );
      this.engine.recordWorkspaceDiscard(
        task,
        archiveWorkspaceId,
        directory,
        input,
        authority,
      );
    }
    // The retry record is what an archive attempt writes. Reading it here is
    // the history this call arrived with, never a new observation.
    const recordedBefore =
      task.resolution.workspaceArchiveRetries.find(
        (record) => record.workspaceId === archiveWorkspaceId,
      ) ?? null;
    // Spec 050: Queue's pause holds every archive attempt, so a paused retry
    // enqueues no cleanup and runs no adapter, Git or build-output work. It
    // reports that plainly below rather than replaying the stored failure as
    // this call's own (papercut: the 10:01 discard retry reported the 09:10
    // Git error although no attempt ran and the pause still held).
    const paused = this.store.getMeta("paused") === true;
    if (!paused) {
      // The existing workspace retry also reopens exhausted thread archive
      // attempts for that workspace. Every native send still re-proves them.
      const exhausted = exhaustedThreadArchives(
        this.store,
        this.store.task(task.id),
        this.store.runs(task.id),
        archiveWorkspaceId,
      );
      for (const agentId of exhausted) {
        const key = this.store.threadArchiveKey(agentId, task.hostId);
        if (!key) continue;
        const prior = this.store.getMeta<Record<string, unknown>>(key);
        if (prior)
          this.store.setMeta(key, { ...prior, retries: 0, nextRetryAt: 0 });
        this.store.event(
          task.id,
          "thread_archive_owner_retry",
          `${agentId}: owner rearmed exhausted archive retries`,
        );
      }
      if (exhausted.length) {
        await archiveFinishedThreads(this.store, this.adapter, task.id);
        if (
          this.engine.terminalThreadsPending(
            this.store.task(task.id),
            this.store.runs(task.id),
          )
        )
          throw Error(
            "Workspace archive still waits for its thread archive; see thread archive wait on the task",
          );
      }
      // Join the automatic cleanup lane, including any archive already in
      // flight. It reads current state, observes unknown delivery and applies
      // the ordinary proofs; terminal cleanup does not reopen task episodes.
      // The verb waits for ITS OWN cleanup occurrence, never for the shared
      // queue to empty: each audit pass re-enqueues every done task, so that
      // queue need never empty and the operation would never settle.
      this.engine.enqueueCleanup(task.id, archiveWorkspaceId);
      await this.engine.awaitProjectionOccurrence(
        `cleanup:${task.id}:${archiveWorkspaceId}`,
        () => this.engine.drainCleanup(),
      );
    }
    const current = this.store.task(task.id);
    if (current.resolution.archivedWorkspaceIds.includes(archiveWorkspaceId))
      return current;
    const recordedAfter =
      current.resolution.workspaceArchiveRetries.find(
        (record) => record.workspaceId === archiveWorkspaceId,
      ) ?? null;
    // Only a rewritten record is a failure this retry actually attempted. An
    // unchanged one is history, and an attempt that never ran is reported as
    // held - by a pause that landed even between the check above and the
    // archive's own - instead of as a fresh failure.
    if (!archiveRetryRecordChanged(recordedBefore, recordedAfter))
      throw Error(
        this.engine.heldArchiveRetryReason(
          current,
          archiveWorkspaceId,
          recordedBefore,
          this.store.getMeta<WorkspaceDiscard>(
            workspaceDiscardKey(task.id, archiveWorkspaceId),
          ) ?? null,
          input.discard === true && !priorDiscard,
        ),
      );
    throw Error(
      recordedAfter
        ? `Workspace archive retry for ${archiveWorkspaceId} attempt ${recordedAfter.attempts} failed: ${recordedAfter.error || current.resolution.cleanupReason || "no cause was recorded"}`
        : current.resolution.cleanupReason ||
            "Terminal workspace archive is still held; no archive was confirmed",
    );
  }

  async retrySupersededReviewView(
    task: Task,
    input: TaskControlInput,
    intentWorkspaceId: string,
  ): Promise<Task> {
    if (input.discard === true)
      throw Error(
        "A content discard does not apply to a superseded review view on an active volume",
      );
    if (this.store.getMeta("paused") === true)
      throw Error(
        "Nucleus is paused; the superseded review view cleanup waits for the pause to clear",
      );
    this.engine.enqueueCleanup(task.id, intentWorkspaceId);
    await this.engine.awaitProjectionOccurrence(
      `cleanup:${task.id}:${intentWorkspaceId}`,
      () => this.engine.drainCleanup(),
    );
    const settled = this.store.task(task.id);
    if (settled.resolution.archivedWorkspaceIds.includes(intentWorkspaceId))
      return settled;
    const retry = settled.resolution.workspaceArchiveRetries.find(
      (record) => record.workspaceId === intentWorkspaceId,
    );
    throw Error(
      retry
        ? `Superseded review view ${intentWorkspaceId} cleanup attempt ${retry.attempts} failed: ${retry.error || "no cause was recorded"}`
        : "Superseded review view cleanup is held; no archive was confirmed",
    );
  }

  /**
   * Papercut: the operational receipt of an owner terminal archive retry whose
   * cleanup pass attempted nothing. It separates the four things a caller must
   * not confuse: whether a content discard authorization is recorded (now or
   * earlier) and durable for a later eligible attempt, that execution is held
   * with no adapter, Git or cleanup call made, and that the stored failure is
   * history with its own time - never this call's observation. It also never
   * claims the discard will succeed once the hold clears. Nothing is written
   * for this receipt: the retry record, the task and the pause are untouched.
   */
  heldArchiveRetryReason(
    task: Task,
    workspaceId: string,
    recorded: WorkspaceArchiveRetry | null,
    discard: WorkspaceDiscard | null,
    discardedNow: boolean,
  ): string {
    const paused = this.store.getMeta("paused") === true;
    let reason = paused
      ? `Nucleus is paused; this retry ran no archive attempt for workspace ${workspaceId}, and the pause still holds`
      : `This retry ran no archive attempt for workspace ${workspaceId}`;
    if (recorded) {
      const observed = this.store
        .eventsAll(task.id)
        .findLast(
          (event) =>
            event.kind === "workspace_cleanup_wait" &&
            event.detail.startsWith(`${workspaceId}: `),
        )?.at;
      reason += `. Its recorded failure (attempt ${recorded.attempts}${observed ? `, observed ${observed}` : ""}) remains history, not this call's observation`;
    } else
      reason += ". No failure record changed and nothing is claimed archived";
    if (discard)
      reason += discardedNow
        ? ". The operator content discard this call recorded is durable and retained for a later eligible attempt, and it lifts no pause"
        : ". The operator content discard already recorded for this workspace is retained for a later eligible attempt";
    return `${reason}.`;
  }
}
