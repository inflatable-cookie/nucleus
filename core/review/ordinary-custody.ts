/**
 * The ordinary review round's custody proof. One detached reviewer round runs in
 * the task's own workspace, so before it is sent every participant must be
 * idle and permission-free, every tool hold proven complete, no other run may
 * own the checkout, and the task reservation must not have moved. The snapshot
 * re-read at the end is what makes the proof hold inside the send guard.
 */
import {
  isDispositionActive,
  type Run,
  type Task,
} from "../../shared/contracts";
import { matchingInactiveParticipant } from "../intake/run-settlement";
import { taskPrNumber } from "../forge/index";
import { currentBrief } from "../planning/brief";
import type { Store } from "../store/store";
import type { HostFacade } from "../host/host-facade";

export interface OrdinaryCustodyContext {
  readonly store: Store;
  readonly host: Pick<HostFacade, "observe">;
  startsNoRuns(): boolean;
}

export class OrdinaryCustody {
  constructor(readonly context: OrdinaryCustodyContext) {}

  ordinaryReviewRuns(taskId: string): string {
    return JSON.stringify(
      this.context.store
        .runs(taskId)
        .map((run) =>
          run.released
            ? { ...run, lastObservedAt: null, active: null, idleSince: null }
            : run,
        ),
    );
  }

  async ordinaryRoundCustody(
    t: Task,
    run: Run,
    restoring = false,
  ): Promise<void> {
    const snapshot = this.ordinaryReviewRuns(t.id);
    const prior = this.context.store.run(run.priorRunId!);
    if (
      !prior?.released ||
      prior.status !== "finished" ||
      !prior.completion ||
      prior.workspaceId !== run.workspaceId ||
      run.workspaceId !== t.workspaceId
    )
      throw Error("Earlier ordinary review custody is not settled");
    const receipt = this.context.store.db
      .prepare("SELECT response FROM receipts WHERE id=? AND task=? AND run=?")
      .get(prior.completion.eventId, t.id, prior.id);
    if (!receipt || JSON.parse(String(receipt.response)).accepted !== true)
      throw Error("Earlier reviewer callback receipt is missing");
    if (
      this.context.store
        .runs(t.id)
        .some((other) => other.id !== run.id && !other.released)
    )
      throw Error("Another run owns the ordinary review checkout");
    const taskParticipants = new Set(
      [
        t.agentId,
        run.agentId,
        ...t.retiredWorkers.map((worker) => worker.agentId),
      ].filter((id): id is string => Boolean(id)),
    );
    const participants = new Map(
      [...taskParticipants].map((id) => [id, t.workspaceId!]),
    );
    if (prior.agentId) participants.set(prior.agentId, t.workspaceId!);
    for (const [id, workspaceId] of participants) {
      const allowRetired = restoring || id !== run.agentId;
      if (!allowRetired) {
        const state = await this.context.host.observe(id);
        if (
          !matchingInactiveParticipant({ agentId: id, workspaceId }, state, [
            "idle",
          ])
        )
          throw Error(
            "Ordinary review participant is not idle and permission-free in the recorded workspace",
          );
      }
    }
    const latest = this.context.store.task(t.id);
    const reviewIdentity = (task: Task) =>
      JSON.stringify([
        task.resolution.currentRunId === run.id ||
        (restoring && run.released && !task.resolution.currentRunId)
          ? run.id
          : task.resolution.currentRunId,
        task.prHead,
        task.prUrl,
        task.workspaceId,
        task.phase,
        task.resolution.reviewerAgentId,
        task.resolution.reviewerProfile,
        taskPrNumber(task),
        currentBrief(task)?.version ?? null,
        currentBrief(task)?.digest ?? null,
      ]);
    if (
      this.context.startsNoRuns() ||
      isDispositionActive(latest) ||
      (latest.resolution.currentRunId !== run.id &&
        !(restoring && run.released && !latest.resolution.currentRunId)) ||
      latest.prHead !== run.head ||
      latest.workspaceId !== t.workspaceId ||
      latest.phase !== t.phase ||
      reviewIdentity(latest) !== reviewIdentity(t)
    )
      throw Error(
        `Ordinary review task reservation changed during custody proof (run ${latest.resolution.currentRunId}/${run.id}, head ${latest.prHead}/${run.head}, phase ${latest.phase}/${t.phase})`,
      );
    if (snapshot !== this.ordinaryReviewRuns(t.id))
      throw Error("Ordinary review run custody changed during proof");
  }
}
