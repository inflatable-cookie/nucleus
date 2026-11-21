import type { Notice } from "../../shared/contracts";
import { parseAgentId } from "../../shared/agent-identity";
import {
  TASK_OWNER_HOLD,
  episodeBindsCurrentWork,
  isDispositionActive,
  isDispositionComplete,
  noticeTaskLine,
  taskOwner,
} from "../../shared/contracts";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { isHostReadRecoveryHeld } from "../recovery/host-read-transient";
import { isWaitingTaskStop, recordedStopIsWait } from "../../shared/task-stop";
import { parseHostOutageNoticeId } from "../../shared/host-outage";
import { isCloseoutHookHold } from "../hooks/hooks";
import {
  NO_ORIGIN_THREAD_WAIT,
  missingOriginHasPlanner,
  noticeId,
  noticeTarget,
  originRecipient,
  originUsesProject,
} from "./origin";
import type { AgentObservation } from "../host/adapter";
import {
  HostReadRefusalError,
  ProvenPreSendRefusalError,
  isAgentGoneRefusal,
} from "../host/errors";
import { qaSettlementHostMessageId } from "../qa/project-qa-notice";
import {
  qaNoticeOwner,
  qaScheduleNoticeProject,
} from "../qa/project-qa-schedule";
import { triageNoticeProject } from "../planning/triage";
import { rowHiddenKey, type RowHiddenEpisode } from "../scheduling/hidden-row";
import type { Resolution } from "../resolution";
import { now } from "../store/store";
import { active } from "../recovery/task-reasons";
import { deliverDecisionNoticesPass } from "./decision-notices";

/**
 * What one pending notice settles as before it is sent: skipped, superseded,
 * re-pointed at its current recipient, left uncertain, kept waiting for a thread,
 * or delivered to the recipient its facts resolve to.
 */
export type NoticeSettlement =
  | { kind: "skip" }
  /** `error` replaces the notice's error text; without one the recorded text stays. */
  | {
      kind: "superseded";
      error?: string;
      coalesced?: { agentId: string; event: string };
    }
  | { kind: "retarget"; agentId: string }
  | { kind: "uncertain"; error: string }
  | { kind: "wait"; error: string }
  | { kind: "send"; recipient: string; escalation: boolean };
/**
 * The ordinary notice settlement, in today's order, over facts the caller reads:
 * the task's disposition and origin, the recipient this notice resolves to, and
 * the completion notices competing for that recipient. A settled notice keeps the
 * recipient it recorded, so a later owner change never reinterprets delivery
 * history (review #602).
 */
export function noticeSettlement(facts: {
  notice: Pick<
    Notice,
    "id" | "kind" | "status" | "agentId" | "originEntry" | "error"
  >;
  taskRemoved: boolean;
  disposition: "active" | "complete" | "none";
  /** The task's origin is unreachable and no project planner can stand in for it. */
  originUnreachable: boolean;
  /** The recipient this notice resolves to now; null when there is no thread. */
  target: string | null;
  /** The one attention notice id the task's current state derives. */
  currentNoticeId: string;
  supportsCoordinatorRecovery: boolean;
  coordinatorNeedsOwner: boolean;
  /** The task's recorded stop is a blocker its owner must act on, and no recovery episode owns it. */
  ownerActionNeeded: boolean;
  awaitingProof: boolean;
  closeoutHookHold: boolean;
  sshAuthExhausted: boolean;
  hostReadExhausted?: boolean;
  /** The task's recovery episode is escalated, so its notice is delivered as an escalation. */
  recoveryEscalated: boolean;
  /** The other completion notices that resolve to the same recipient: one already settled, or the first pending. */
  completionCohort: { settled: boolean; firstPendingId: string | null } | null;
}): NoticeSettlement {
  const { notice } = facts;
  const completion = notice.kind === "completion";
  const prerequisite = notice.kind === "prerequisite";
  if (facts.taskRemoved) return { kind: "skip" };
  if (facts.disposition === "active") return { kind: "skip" };
  if (facts.disposition === "complete")
    return {
      kind: "superseded",
      error: "Task disposition completed before notice settlement",
    };
  if ((!completion || notice.originEntry) && facts.originUnreachable)
    return { kind: "skip" };
  // Only a pending notice is coalesced: an interrupted intent keeps its recorded
  // recipient and settles as uncertain below (review #602).
  if (
    completion &&
    facts.target !== null &&
    notice.status === "pending" &&
    facts.completionCohort &&
    (facts.completionCohort.settled ||
      facts.completionCohort.firstPendingId !== notice.id)
  ) {
    const reason = `Completion coalesced because multiple cohort entries resolve to ${facts.target}`;
    return {
      kind: "superseded",
      error: reason,
      coalesced: {
        agentId: facts.target,
        event: "completion_notice_coalesced",
      },
    };
  }
  if (facts.target !== null && notice.agentId !== facts.target) {
    if (notice.status === "pending")
      return { kind: "retarget", agentId: facts.target };
    return {
      kind: "uncertain",
      error:
        "Origin changed after delivery intent; inspect old thread before resending",
    };
  }
  // A wait clears on its own and a hold has its own owner reminders (Spec 040).
  // A stop only the owner can exit is not that, so its notice stays pending until
  // delivery, a later episode replaces it, or the stop clears. A live recovery
  // episode still owns its stop: the owner hears when it escalates or refuses.
  if (
    !completion &&
    !prerequisite &&
    !facts.ownerActionNeeded &&
    facts.supportsCoordinatorRecovery &&
    !facts.coordinatorNeedsOwner &&
    !facts.awaitingProof &&
    !facts.closeoutHookHold &&
    !facts.sshAuthExhausted &&
    !facts.hostReadExhausted
  )
    return {
      kind: "superseded",
      error:
        "The task waits on a condition that clears on its own; no owner action is owed",
    };
  if (
    !completion &&
    !prerequisite &&
    notice.status === "pending" &&
    notice.id !== facts.currentNoticeId
  )
    return {
      kind: "superseded",
      error: "A later attention episode replaced this notice",
    };
  if (notice.status === "intent")
    return {
      kind: "uncertain",
      error: `Restart during delivery; inspect ${completion ? "recipient" : "origin"} thread before resending`,
    };
  // No thread to receive it, after the ordinary settlement rules: the notice stays
  // pending and visible on the board, and is never sent to a fictitious agent.
  if (facts.target === null)
    return { kind: "wait", error: NO_ORIGIN_THREAD_WAIT };
  return {
    kind: "send",
    recipient: facts.target,
    escalation: !completion && facts.recoveryEscalated,
  };
}

export interface DurableSendOptions<T> {
  recipient: string;
  /** Replaces the plain observation, for a recipient that needs an identity check first; null means handled. */
  observe?: () => Promise<AgentObservation | null>;
  aborted?: () => boolean;
  lookupWait: (message: string) => string;
  busyWait: (state: AgentObservation) => string;
  ready?: (state: AgentObservation) => boolean;
  wait: (reason: string) => void;
  /** The recipient thread no longer exists; omitted, a missing thread is an ordinary lookup wait. */
  gone?: () => void;
  confirm: () => T | null;
  target: (record: T) => {
    agentId: string;
    id: string;
    text: string;
    sourceAgentId?: string;
  };
  /** Steer into a live turn when the host supports it, instead of `sendMessage`. */
  steer?: boolean;
  refused?: (record: T, reason: string) => void;
  sendTimeoutMs?: number;
  registerStopWaiter?: (wake: () => void) => () => void;
  mark: (
    record: T,
    status: "intent" | "delivered" | "uncertain",
    error: string,
    failure?: unknown,
  ) => void;
}

/** Durable notices: attention, completion, hold, lane-drain and decision prompts, all through one intent-before-send path. */
export class Notices {
  constructor(readonly resolution: Resolution) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  paused() {
    return this.resolution.paused();
  }

  /**
   * The one durable send every notice lifecycle shares: observe the recipient,
   * wait while it is busy or unobservable, then record intent before the send and
   * `delivered` or `uncertain` after it. A send is never repeated blindly: an
   * `intent` left by a restart becomes `uncertain` in the caller's loop. `confirm`
   * re-reads the durable record after the awaited observation; null skips the send.
   */
  async sendDurably<T>(d: DurableSendOptions<T>): Promise<"paused" | "done"> {
    let state: AgentObservation | null;
    try {
      state = d.observe
        ? await d.observe()
        : await this.resolution.host.observe(d.recipient);
    } catch (error) {
      if (d.aborted?.()) return "done";
      if (isAgentGoneRefusal(error)) {
        this.resolution.responsibleThreads.cache.invalidateMatching(
          d.recipient,
        );
        if (d.gone) {
          d.gone();
          return "done";
        }
      }
      d.wait(
        d.lookupWait(error instanceof Error ? error.message : String(error)),
      );
      return "done";
    }
    if (d.aborted?.()) return "done";
    if (!state) return "done";
    if (
      state.archived ||
      state.status === "closed" ||
      state.status === "gone"
    ) {
      this.resolution.responsibleThreads.cache.invalidateMatching(d.recipient);
      d.gone?.();
      return "done";
    }
    if (!(d.ready ? d.ready(state) : !active(state))) {
      d.wait(d.busyWait(state));
      return "done";
    }
    if (this.paused()) return "paused";
    const record = d.confirm();
    if (!record) return "done";
    const target = d.target(record);
    d.mark(record, "intent", "");
    const sendPromise = d.steer
      ? this.resolution.host.steerOrNotify(target.agentId, {
          messageId: target.id,
          text: target.text,
          sourceAgentId: target.sourceAgentId,
        })
      : this.resolution.host.sendMessage(target.agentId, {
          messageId: target.id,
          text: target.text,
          sourceAgentId: target.sourceAgentId,
        });
    if (d.sendTimeoutMs === undefined && !d.registerStopWaiter) {
      try {
        await sendPromise;
        d.mark(record, "delivered", "");
      } catch (error) {
        this.resolution.responsibleThreads.cache.invalidateMatching(
          d.recipient,
        );
        if (
          (error instanceof ProvenPreSendRefusalError ||
            error instanceof HostReadRefusalError) &&
          d.refused
        ) {
          d.refused(record, error.message);
        } else if (
          error instanceof ProvenPreSendRefusalError ||
          error instanceof HostReadRefusalError
        ) {
          // A refusal proved nothing left this process, so the notice is not an
          // unknown delivery: it stays pending and is retried on a later pass
          // (nucleus#1445).
          d.wait(error.message);
        } else {
          d.mark(record, "uncertain", String(error), error);
        }
      }
      return "done";
    }
    void sendPromise.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unregisterStop: (() => void) | undefined;
    let abandoned = false;
    const outcome = await new Promise<
      { kind: "settled" } | { kind: "abandoned"; reason: string }
    >((resolve) => {
      if (d.sendTimeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (abandoned) return;
          abandoned = true;
          resolve({
            kind: "abandoned",
            reason: `Delivery timed out after ${d.sendTimeoutMs} ms; outcome unknown`,
          });
        }, d.sendTimeoutMs);
        timer.unref?.();
      }
      if (d.registerStopWaiter) {
        unregisterStop = d.registerStopWaiter(() => {
          if (abandoned) return;
          abandoned = true;
          resolve({
            kind: "abandoned",
            reason: "Engine stopped during delivery; outcome unknown",
          });
        });
      }
      sendPromise.then(
        () => {
          if (abandoned) return;
          resolve({ kind: "settled" });
        },
        () => {
          if (abandoned) return;
          resolve({ kind: "settled" });
        },
      );
    }).finally(() => {
      if (timer) clearTimeout(timer);
      unregisterStop?.();
    });
    if (outcome.kind === "abandoned") {
      this.resolution.responsibleThreads.cache.invalidateMatching(d.recipient);
      d.mark(record, "uncertain", outcome.reason, {
        lateDelivery: true,
        late: sendPromise,
      });
      return "done";
    }
    try {
      await sendPromise;
      d.mark(record, "delivered", "");
    } catch (error) {
      this.resolution.responsibleThreads.cache.invalidateMatching(d.recipient);
      if (
        (error instanceof ProvenPreSendRefusalError ||
          error instanceof HostReadRefusalError) &&
        d.refused
      ) {
        d.refused(record, error.message);
      } else if (
        error instanceof ProvenPreSendRefusalError ||
        error instanceof HostReadRefusalError
      ) {
        // A refusal proved nothing left this process, so the notice is not an unknown
        // delivery: it stays pending and is retried on a later pass, when the reason
        // the host named (a manual snooze, a thread that is not active yet) no longer
        // holds (nucleus#1445).
        d.wait(error.message);
      } else {
        d.mark(record, "uncertain", String(error), error);
      }
    }
    return "done";
  }
  /**
   * Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait): the one notice a
   * host outage past the dispatch-limits bound delivers to an affected project's
   * planner. Raised once per outage on a project-level notice id; this pass sends
   * it through the same pending/intent/delivered path as a hold prompt and never
   * resends after an uncertain send.
   *
   * Planner ruling (2026-11-14, in this task's brief): the notice is about a live
   * outage. When the outage ended before delivery — for example while its
   * planner's own host was unreachable — the notice is superseded with the reason
   * below and is not sent; its stored text is never rewritten or composed at
   * delivery. The planner's host may be a different, healthy one (a Paseo planner
   * for a T3 project), so delivery resolves that host before sending.
   */
  async deliverHostOutageNotices() {
    if (this.paused()) return;
    for (let n of this.store.pendingNotices()) {
      if (this.paused()) return;
      if (n.kind !== "host_outage") continue;
      // Durable intent first (planner ruling, 2026-11-14; nucleus#1198 review):
      // sendDurably writes `intent` before the remote send, so an intent left by a
      // restart proves nothing about delivery. It settles as `uncertain` whatever
      // the outage now says — the ended-outage rule below applies only to a
      // known-pending notice, so unknown delivery is never relabelled as not sent.
      if (n.status === "intent") {
        this.store.putNotice({
          ...n,
          status: "uncertain",
          error:
            "Restart during delivery; inspect the planner thread before resending",
        });
        continue;
      }
      const identity = parseHostOutageNoticeId(n.id);
      const outage = identity
        ? this.resolution.hostOutage(identity.hostId)
        : null;
      const live = Boolean(
        identity && outage && outage.since === identity.since,
      );
      const ended = "outage ended before delivery";
      if (!live) {
        this.store.putNotice({ ...n, status: "superseded", error: ended });
        continue;
      }
      const project = this.store.projectByKey(
        n.taskId.replace(/^project:/, ""),
      );
      const resolved = project
        ? (await this.resolution.responsibleThread(project)).thread
        : null;
      if (!resolved) {
        if (project)
          this.store.putNotice({
            ...n,
            error: `No live responsible thread for ${project.key}`,
          });
        continue;
      }
      if (n.agentId !== resolved.agentId || n.error) {
        n = {
          ...n,
          agentId: resolved.agentId,
          recipientAgentId: resolved.agentId,
          error: "",
        };
        this.store.putNotice(n);
      }
      const recipientHost =
        parseAgentId(n.agentId)?.hostId ??
        (await this.resolution.identifyOriginHost(n.agentId));
      if (!recipientHost) {
        if (n.error !== "Waiting for a proven planner host")
          this.store.putNotice({
            ...n,
            error: "Waiting for a proven planner host",
          });
        continue;
      }
      if (
        !this.resolution.withHost(
          recipientHost,
          () =>
            this.resolution.originHostAvailable(recipientHost) &&
            Boolean(this.adapter.notify),
        )
      ) {
        const reason = `Waiting for host ${recipientHost}`;
        if (n.error !== reason) this.store.putNotice({ ...n, error: reason });
        continue;
      }
      const sent = await this.resolution.withHost(recipientHost, () =>
        this.sendDurably({
          recipient: n.agentId,
          lookupWait: (message) =>
            `Waiting for the project planner: ${message}`,
          busyWait: (state) =>
            `Waiting for the project planner to finish (${state.status})`,
          wait: (reason) => {
            if (n.error !== reason)
              this.store.putNotice({ ...n, error: reason });
          },
          gone: () =>
            this.store.putNotice({
              ...n,
              error: "The responsible thread is no longer available",
            }),
          confirm: () => {
            const current = this.store
              .notices(n.taskId)
              .find((notice) => notice.id === n.id);
            if (!current || current.status !== "pending") return null;
            const still = this.resolution.hostOutage(identity!.hostId);
            if (!still || still.since !== identity!.since) {
              this.store.putNotice({
                ...current,
                status: "superseded",
                error: ended,
              });
              return null;
            }
            return current;
          },
          target: (current) => ({
            agentId: current.agentId,
            id: current.id,
            text: current.text,
          }),
          mark: (current, status, error) =>
            this.store.putNotice({ ...current, error, status }),
        }),
      );
      if (sent === "paused") return;
    }
  }
  /**
   * Spec 041 delivery: one durable notice per drain episode reaches the plan owner's thread
   * through the same pending/intent/delivered path as a hold prompt, never resent blindly.
   * A notice whose episode ended, or whose owner thread is gone, is superseded; the
   * escalation timer covers an unreachable owner, so the operator still sees the item.
   */
  async deliverDrainNotices() {
    if (this.paused()) return;
    for (let n of this.store.pendingNotices()) {
      if (this.paused()) return;
      if (
        n.kind !== "lane_drain" &&
        n.kind !== "next_aim" &&
        n.kind !== "qa" &&
        n.kind !== "triage"
      )
        continue;
      const [scope, key, ...rest] = n.id.split(":");
      const since = rest.join(":");
      const episodeLive = () => {
        try {
          // A triage prompt is live while its batch is the project's outstanding batch.
          if (n.kind === "triage")
            return Boolean(triageNoticeProject(this.store, n));
          if (scope === "lane-drain")
            return this.store.laneByKey(key)?.drain?.since === since;
          if (scope === "next-aim")
            return this.store.projectByKey(key)?.drain?.since === since;
          return n.kind === "qa";
        } catch {
          return false;
        }
      };
      if (n.status === "intent") {
        this.store.putNotice({
          ...n,
          status: "uncertain",
          error:
            "Restart during delivery; inspect the owner thread before resending",
        });
        continue;
      }
      const scheduledQa =
        n.kind === "qa" && !n.id.startsWith("project-qa-settled:");
      const qaProject = scheduledQa
        ? qaScheduleNoticeProject(this.store, n)
        : null;
      if (n.kind === "triage") {
        // The planner is the project's current responsible thread, resolved at delivery like a scheduled QA prompt.
        const project = triageNoticeProject(this.store, n);
        if (!project) {
          this.store.putNotice({
            ...n,
            status: "superseded",
            error: "The triage batch ended before the prompt was delivered",
          });
          continue;
        }
        const { thread } = await this.resolution.responsibleThread(project);
        if (!thread) {
          if (n.error !== "No live responsible thread")
            this.store.putNotice({ ...n, error: "No live responsible thread" });
          continue;
        }
        if (n.agentId !== thread.agentId || n.error) {
          n = {
            ...n,
            agentId: thread.agentId,
            recipientAgentId: thread.agentId,
            error: "",
          };
          this.store.putNotice(n);
        }
      }
      let live = episodeLive();
      if (n.kind === "qa") {
        live = scheduledQa
          ? Boolean(qaProject)
          : Boolean(qaNoticeOwner(this.store, n));
        if (qaProject) {
          const { thread } = await this.resolution.responsibleThread(qaProject);
          if (!thread) {
            if (n.error !== "No live responsible thread")
              this.store.putNotice({
                ...n,
                error: "No live responsible thread",
              });
            continue;
          }
          if (n.agentId !== thread.agentId || n.error) {
            n = {
              ...n,
              agentId: thread.agentId,
              recipientAgentId: thread.agentId,
              error: "",
            };
            this.store.putNotice(n);
          }
        }
      }
      if (!live) {
        this.store.putNotice({
          ...n,
          status: "superseded",
          error: "The drain episode ended before the prompt was delivered",
        });
        continue;
      }
      if (n.status === "pending" && n.kind !== "qa" && n.kind !== "triage") {
        const project =
          n.kind === "next_aim"
            ? this.store.projectByKey(key)
            : this.store.projects().find((candidate) => {
                try {
                  return this.store
                    .plan({ project: candidate.key })
                    .entries.some((entry) => entry.lane === key);
                } catch {
                  return false;
                }
              });
        const thread = project
          ? (await this.resolution.responsibleThread(project)).thread
          : null;
        if (!thread) {
          if (n.error !== "No live responsible thread")
            this.store.putNotice({ ...n, error: "No live responsible thread" });
          continue;
        }
        if (n.agentId !== thread.agentId) {
          n = {
            ...n,
            agentId: thread.agentId,
            recipientAgentId: thread.agentId,
            error: "",
          };
          this.store.putNotice(n);
        }
      }
      const recipientHost =
        parseAgentId(n.agentId)?.hostId ??
        (await this.resolution.identifyOriginHost(n.agentId));
      if (
        !recipientHost ||
        !this.resolution.withHost(
          recipientHost,
          () =>
            this.resolution.originHostAvailable(recipientHost) &&
            Boolean(this.adapter.notify),
        )
      )
        continue;
      const sent = await this.resolution.withHost(recipientHost, () =>
        this.sendDurably({
          recipient: n.agentId,
          lookupWait: (message) => `Waiting for the plan owner: ${message}`,
          busyWait: (state) =>
            `Waiting for the plan owner to finish (${state.status})`,
          wait: (reason) => {
            if (n.error !== reason)
              this.store.putNotice({ ...n, error: reason });
          },
          gone: () =>
            this.store.putNotice(
              n.kind === "qa" && !scheduledQa
                ? {
                    ...n,
                    status: "superseded",
                    error: "The QA recipient is no longer available",
                  }
                : {
                    ...n,
                    error: "The responsible thread is no longer available",
                  },
            ),
          confirm: () => {
            // Plan saves and lane-document edits may land while the owner is finishing
            // another run. Refresh at the delivery boundary and retain the episode ID.
            if (n.kind !== "qa" && n.kind !== "triage")
              this.store.evaluateLaneDrains();
            const current = this.store
              .notices(n.taskId)
              .find((notice) => notice.id === n.id);
            if (!current || current.status !== "pending") return null;
            let stillLive = episodeLive();
            if (qaProject) {
              const latest = qaScheduleNoticeProject(this.store, current);
              stillLive = Boolean(latest);
              if (
                latest &&
                (latest.key !== qaProject.key ||
                  latest.version !== qaProject.version ||
                  latest.planner?.agentId !== qaProject.planner?.agentId ||
                  qaNoticeOwner(this.store, current) !== n.agentId)
              )
                return null;
            } else if (n.kind === "qa") {
              stillLive = Boolean(qaNoticeOwner(this.store, current));
            }
            if (!stillLive) {
              this.store.putNotice({
                ...current,
                status: "superseded",
                error:
                  "The drain episode ended before the prompt was delivered",
              });
              return null;
            }
            return current;
          },
          target: (current) => {
            if (
              current.kind === "qa" &&
              current.id.startsWith("project-qa-settled:")
            ) {
              const runId = current.taskId.startsWith("qa:")
                ? current.taskId.slice(3)
                : "";
              return {
                agentId: current.agentId,
                id: qaSettlementHostMessageId(runId, current.agentId),
                text: current.text,
              };
            }
            return {
              agentId: current.agentId,
              id: current.id,
              text: current.text,
            };
          },
          mark: (current, status, error) =>
            this.store.putNotice({ ...current, error, status }),
        }),
      );
      if (sent === "paused") return;
    }
  }
  async deliverNotices(scopedHost?: string) {
    if (!scopedHost) {
      const tasks = [
        ...this.store.maintenanceTasks(true),
        ...this.store
          .pendingNotices()
          .filter(
            (n) =>
              !["host_outage", "lane_drain", "next_aim", "qa"].includes(n.kind),
          )
          .map((n) => this.store.task(n.taskId)),
      ];
      for (const n of this.store.pendingNotices()) {
        if (
          n.status !== "pending" ||
          ["host_outage", "lane_drain", "next_aim", "qa"].includes(n.kind)
        )
          continue;
        if (
          !this.store.task(n.taskId).originHostId &&
          n.error !== "Waiting for a proven origin host"
        )
          this.store.putNotice({
            ...n,
            error: "Waiting for a proven origin host",
          });
      }
      for (const host of new Set(
        tasks.flatMap((task) => (task.originHostId ? [task.originHostId] : [])),
      ))
        await this.resolution.withHost(host, () => this.deliverNotices(host));
      return;
    }
    if (!this.resolution.originHostAvailable(scopedHost)) {
      for (const n of this.store.pendingNotices()) {
        if (
          n.status !== "pending" ||
          ["host_outage", "lane_drain", "next_aim", "qa"].includes(n.kind)
        )
          continue;
        if (
          this.store.task(n.taskId).originHostId === scopedHost &&
          n.error !== `Waiting for host ${scopedHost}`
        )
          this.store.putNotice({
            ...n,
            error: `Waiting for host ${scopedHost}`,
          });
      }
      return;
    }
    if (!this.adapter.notify || this.paused()) return;
    for (const task of this.store.maintenanceTasks(true)) {
      if (task.originHostId !== scopedHost) continue;
      if (
        task.removedAt ||
        task.originLookupError ||
        isDispositionActive(task) ||
        isDispositionComplete(task) ||
        task.phase === "done"
      )
        continue;
      const stop = task.resolution.stop;
      const recovery = task.resolution.recovery;
      // A superseded coordinator episode is history (papercut 1792f99d): a
      // resolved episode, or its action marked not applied because an owner verb
      // superseded it, is never a current need for the owner and its prose is
      // never quoted in a fresh notice. The current stop is the actionable fact.
      const episodeOpen = episodeBindsCurrentWork(task);
      const coordinatorNeedsOwner =
        episodeOpen &&
        (recovery!.status === "escalated" ||
          (recovery!.status !== "pending" &&
            recovery!.action?.status === "refused"));
      const awaitingProof = stop?.reason === "awaiting_proof";
      const hostReadExhausted =
        isHostReadRecoveryHeld(this.store, task) === "exhausted";
      const locallyActionable =
        awaitingProof ||
        isCloseoutHookHold(task) ||
        task.reasonFact?.code === "ssh_auth" ||
        hostReadExhausted;
      // A recorded stop whose reason is not a wait is attention whatever the
      // phase says: Queue has stopped and named an owner verb it cannot apply
      // itself (nucleus#1159: a review blocked on an uncertain side effect keeps
      // its phase, so the phase alone would leave the owner uninformed). A
      // recovery episode still owns its stop, though: that coordinator acts, and
      // its escalation or refusal is what makes the owner's notice due.
      const ownerActionNeeded =
        Boolean(stop && stop.reason !== "held" && !recordedStopIsWait(stop)) &&
        !episodeOpen;
      const legacyAttention =
        !this.adapter.supportsCoordinatorRecovery &&
        Boolean(
          (task.originError && !missingOriginHasPlanner(this.store, task)) ||
            task.resolution.attention ||
            ["blocked", "error", "needs_attention"].includes(task.phase),
        );
      if (
        !coordinatorNeedsOwner &&
        !locallyActionable &&
        !legacyAttention &&
        !ownerActionNeeded
      )
        continue;
      // A wait clears on its own and a hold has its own owner reminders (Spec 040).
      if (
        this.adapter.supportsCoordinatorRecovery &&
        stop &&
        (isWaitingTaskStop(stop.reason) || stop.reason === "held") &&
        !coordinatorNeedsOwner &&
        !locallyActionable
      )
        continue;
      const id = noticeId(this.store.task(task.id));
      if (this.store.notices(task.id).some((notice) => notice.id === id))
        continue;
      const detail =
        episodeOpen && recovery?.action?.status === "refused"
          ? `${stop?.detail ?? task.reason}\nCoordinator could not apply its report: ${recovery.action.reason ?? recovery.summary}`
          : episodeOpen && recovery?.status === "escalated"
            ? recovery.summary
            : (stop?.detail ?? task.reason);
      const suggested = stop?.suggestedVerbs.length
        ? `\nSuggested verbs: ${stop.suggestedVerbs.join(", ")}`
        : "";
      const remapHint = task.reasonFact?.code === "retained_profile"
        ? "\nOwner action: restart remaps the retained worker to an eligible profile, with an optional instruction as its continuation; route role=worker chooses the profile."
        : "";
      const proofOwner = awaitingProof
        ? this.store.projectPlannerRecipient(
            this.store.projectFor(
              task.repoPath,
              normalizeRepositoryOrigin(task.repository ?? ""),
            ),
          )
        : null;
      this.store.putNotice({
        id,
        taskId: task.id,
        agentId:
          proofOwner ?? originRecipient(this.store, task) ?? taskOwner(task),
        recipientAgentId: proofOwner ?? taskOwner(task),
        workspaceId: task.originWorkspaceId,
        sources: [],
        originEntry: !proofOwner,
        kind: "attention",
        status: "pending",
        error: "",
        text: `Nucleus needs attention\n${noticeTaskLine(task)}\nState: ${task.phase}\n${detail}${suggested}${remapHint}\nWorker: ${task.agentId ?? "none"}\nCoordinator: ${task.coordinatorAgentId || "unassigned"}\nPR: ${task.prUrl ?? "none"}\nInspect the queue detail before choosing the next action. This is a plugin notice, not new planning authority.`,
      });
    }
    for (const n of this.store.pendingNotices()) {
      if (this.paused()) return;
      if (
        n.kind === "hold" ||
        n.kind === "hold_release" ||
        n.kind === "row_hidden" ||
        n.kind === "host_outage" ||
        n.kind === "lane_drain" ||
        n.kind === "next_aim" ||
        n.kind === "qa"
      )
        continue;
      const task = this.store.task(n.taskId);
      if (task.originHostId !== scopedHost) continue;
      const completion = n.kind === "completion";
      if (n.status === "pending" && n.originEntry && originUsesProject(task)) {
        const project = this.store.projectFor(
          task.repoPath,
          normalizeRepositoryOrigin(task.repository ?? ""),
        );
        if (project && !this.store.projectPlannerRecipient(project))
          await this.resolution.responsibleThread(project);
      }
      const target = noticeTarget(this.store, task, n);
      // A settled notice keeps the recipient it recorded: a later owner change never
      // reinterprets delivery history (review #602).
      const resolvedTo = (other: Notice) =>
        ["delivered", "intent", "uncertain"].includes(other.status)
          ? other.agentId
          : noticeTarget(this.store, task, other);
      let completionCohort: {
        settled: boolean;
        firstPendingId: string | null;
      } | null = null;
      if (completion && target !== null) {
        const collisions = this.store
          .notices(task.id)
          .filter(
            (other) =>
              other.id !== n.id &&
              other.kind === "completion" &&
              other.status !== "superseded" &&
              resolvedTo(other) === target,
          );
        const settled = collisions.find((other) =>
          ["delivered", "intent", "uncertain"].includes(other.status),
        );
        const pending = [n, ...collisions]
          .filter((other) => other.status === "pending")
          .sort(
            (a, b) =>
              Number(b.originEntry) - Number(a.originEntry) ||
              a.id.localeCompare(b.id),
          );
        completionCohort = {
          settled: Boolean(settled),
          firstPendingId: pending[0]?.id ?? null,
        };
      }
      const coordinatorNeedsOwner =
        task.resolution.recovery?.status === "escalated" ||
        task.resolution.recovery?.action?.status === "refused";
      // The same fact the raise above uses: a stop whose reason is not a wait is
      // the owner's, so its notice is never settled as a self-clearing wait.
      const settlementStop = task.resolution.stop;
      const ownerActionNeeded =
        Boolean(
          settlementStop &&
            settlementStop.reason !== "held" &&
            !recordedStopIsWait(settlementStop),
        ) && !episodeBindsCurrentWork(task);
      const facts: Parameters<typeof noticeSettlement>[0] = {
        notice: n,
        taskRemoved: Boolean(task.removedAt),
        disposition: isDispositionActive(task)
          ? "active"
          : isDispositionComplete(task)
            ? "complete"
            : "none",
        originUnreachable:
          (!completion || n.originEntry) &&
          Boolean(task.originError || task.originLookupError) &&
          !missingOriginHasPlanner(this.store, task),
        target,
        currentNoticeId: noticeId(task),
        supportsCoordinatorRecovery: Boolean(
          this.adapter.supportsCoordinatorRecovery,
        ),
        coordinatorNeedsOwner,
        ownerActionNeeded,
        awaitingProof: task.resolution.stop?.reason === "awaiting_proof",
        closeoutHookHold: isCloseoutHookHold(task),
        sshAuthExhausted: task.reasonFact?.code === "ssh_auth",
        hostReadExhausted:
          isHostReadRecoveryHeld(this.store, task) === "exhausted",
        recoveryEscalated: task.resolution.recovery?.status === "escalated",
        completionCohort,
      };
      let settlement = noticeSettlement(facts);
      // A pending notice re-points at its current recipient and settles in the
      // same pass; an interrupted one never does.
      const retargeted =
        settlement.kind === "retarget" ? settlement.agentId : null;
      if (retargeted !== null) {
        this.store.putNotice({ ...n, agentId: retargeted });
        settlement = noticeSettlement({
          ...facts,
          notice: { ...n, agentId: retargeted },
        });
      }
      if (settlement.kind === "skip") continue;
      if (settlement.kind === "superseded") {
        this.store.putNotice({
          ...n,
          status: "superseded",
          ...(settlement.error === undefined
            ? {}
            : { error: settlement.error }),
          ...(settlement.coalesced
            ? { agentId: settlement.coalesced.agentId }
            : {}),
        });
        if (settlement.coalesced)
          this.store.event(
            task.id,
            settlement.coalesced.event,
            `${n.id} → ${settlement.coalesced.agentId}`,
          );
        continue;
      }
      if (settlement.kind === "retarget") {
        this.store.putNotice({ ...n, agentId: settlement.agentId });
        continue;
      }
      if (settlement.kind === "uncertain") {
        this.store.putNotice({
          ...n,
          status: "uncertain",
          error: settlement.error,
        });
        continue;
      }
      if (settlement.kind === "wait") {
        if (n.error !== settlement.error)
          this.store.putNotice({ ...n, error: settlement.error });
        continue;
      }
      const recipient = settlement.recipient;
      const escalation = settlement.escalation;
      const recipientHost =
        recipient === task.originAgentId ||
        recipient === task.notificationAgentId
          ? task.originHostId
          : await this.resolution.identifyOriginHost(recipient);
      if (
        !recipientHost ||
        !this.resolution.withHost(recipientHost, () =>
          this.resolution.originHostAvailable(recipientHost),
        )
      ) {
        const error = recipientHost
          ? `Waiting for host ${recipientHost}`
          : "Waiting for a proven recipient host";
        if (n.error !== error) this.store.putNotice({ ...n, error });
        continue;
      }
      const sent = await this.resolution.withHost(recipientHost, () =>
        this.sendDurably({
          recipient,
          observe: async () => {
            if (completion && !n.originEntry && !this.adapter.originAgent) {
              const reason =
                "Waiting for completion recipient identity validation";
              if (n.error !== reason)
                this.store.putNotice({ ...n, error: reason });
              return null;
            }
            if (completion && !n.originEntry && this.adapter.originAgent) {
              const identity =
                await this.resolution.host.originAgent(recipient);
              if (
                !identity ||
                identity.archived ||
                identity.workspaceId !== n.workspaceId
              ) {
                this.store.putNotice({
                  ...n,
                  status: "superseded",
                  error:
                    "Completion recipient is missing, archived or moved from its recorded workspace",
                });
                return null;
              }
            }
            return this.resolution.host.observe(recipient);
          },
          lookupWait: (message) =>
            `Waiting for ${completion ? "recipient" : "origin thread"} lookup: ${message}`,
          // Every notice, escalations included, waits for the recipient's turn to end: an escalation
          // delivered into a running origin thread cut across the operator's live conversation (Tom,
          // 2026-10-04). The notice stays pending and durable; nothing is lost by waiting.
          ready: (state) =>
            !active(state) &&
            ["idle", "error", "closed"].includes(state.status),
          busyWait: (state) =>
            `Waiting for ${completion ? "completion recipient" : "origin thread"} to become idle${escalation ? ` (escalation; ${state.status})` : ""}`,
          wait: (reason) => {
            if (n.error !== reason)
              this.store.putNotice({ ...n, agentId: recipient, error: reason });
          },
          gone:
            completion && !n.originEntry
              ? () =>
                  this.store.putNotice({
                    ...n,
                    status: "superseded",
                    error: "Completion recipient is no longer available",
                  })
              : undefined,
          // The recipient may change while it is observed (an owner change): re-read the
          // durable notice and its current recipient, and never send to a stale one (review #602).
          confirm: () => {
            const current = this.store
              .notices(n.taskId)
              .find((notice) => notice.id === n.id);
            if (!current || current.status !== "pending") return null;
            if (
              noticeTarget(this.store, this.store.task(n.taskId), current) !==
              recipient
            )
              return null;
            return current;
          },
          target: (notice) => {
            const task = this.store.task(notice.taskId);
            return {
              agentId: recipient,
              id: notice.id,
              text: notice.text,
              sourceAgentId:
                task.hostId === recipientHost
                  ? (task.agentId ?? undefined)
                  : undefined,
            };
          },
          mark: (notice, status, error) =>
            this.store.putNotice(
              status === "uncertain"
                ? { ...notice, status, error }
                : { ...notice, agentId: recipient, error, status },
            ),
        }),
      );
      if (sent === "paused") return;
    }
  }
  /**
   * Spec 040 delivery: a hold prompt reaches the hold owner's thread through the durable
   * notice path (intent before send, uncertain after a failure, never resent blindly). A
   * release or a task that stopped being held supersedes the prompt before it is sent.
   */
  async deliverHoldNotices(scopedHost?: string) {
    if (!scopedHost) {
      const hosts = new Set(
        this.store
          .pendingNotices()
          .filter((n) => n.kind === "hold" || n.kind === "hold_release")
          .flatMap((n) => {
            const host = this.store.task(n.taskId).originHostId;
            return host ? [host] : [];
          }),
      );
      for (const host of hosts)
        await this.resolution.withHost(host, () =>
          this.deliverHoldNotices(host),
        );
      return;
    }
    if (!this.resolution.originHostAvailable(scopedHost)) return;
    if (!this.adapter.notify || this.paused()) return;
    for (const n of this.store.pendingNotices()) {
      if (this.paused()) return;
      if (n.kind !== "hold" && n.kind !== "hold_release") continue;
      if (this.store.task(n.taskId).originHostId !== scopedHost) continue;
      const release = n.kind === "hold_release";
      // A prompt for a hold that is gone is stale. A release notice describes a past
      // event and stays true after a later generation re-holds the task or the task
      // merges, so it is delivered even then; only a missing thread supersedes it.
      const holdGone = () => {
        const task = this.store.task(n.taskId);
        return (
          !release &&
          (task.removedAt ||
            task.resolution.mergeIntent ||
            task.resolution.mergedCommit ||
            !task.held)
        );
      };
      if (holdGone()) {
        this.store.putNotice({
          ...n,
          status: "superseded",
          error: "Hold was released before the prompt was delivered",
        });
        continue;
      }
      if (n.status === "intent") {
        this.store.putNotice({
          ...n,
          status: "uncertain",
          error:
            "Restart during delivery; inspect the owner thread before resending",
        });
        continue;
      }
      // An owner-placed hold's notice goes to whoever owns the task now: a pending
      // notice written before an owner change is re-pointed, never sent to the old
      // owner (Spec 040). A settled one keeps the recipient it recorded.
      if (n.recipientAgentId === TASK_OWNER_HOLD) {
        const owner = taskOwner(this.store.task(n.taskId));
        if (owner !== n.agentId) {
          this.store.putNotice({ ...n, agentId: owner, error: "" });
          continue;
        }
      }
      // Origin transfer can change a pending hold notice's route while observe() is
      // in flight. Every write after the await re-reads its durable identity and
      // status, so a stale snapshot cannot notify the retired owner after transfer.
      const unchanged = () => {
        const current = this.store
          .notices(n.taskId)
          .find((notice) => notice.id === n.id);
        return current &&
          current.status === "pending" &&
          current.agentId === n.agentId
          ? current
          : null;
      };
      const sending = (record: Notice) => {
        const current = this.store
          .notices(record.taskId)
          .find((notice) => notice.id === record.id);
        return current?.status === "intent" &&
          current.agentId === record.agentId
          ? current
          : null;
      };
      const task = this.store.task(n.taskId);
      const recipientHost =
        n.agentId === task.originAgentId ||
        n.agentId === task.notificationAgentId
          ? task.originHostId
          : await this.resolution.identifyOriginHost(n.agentId);
      if (
        !recipientHost ||
        !this.resolution.withHost(
          recipientHost,
          () =>
            this.resolution.originHostAvailable(recipientHost) &&
            Boolean(this.adapter.notify),
        )
      )
        continue;
      const sent = await this.resolution.withHost(recipientHost, () =>
        this.sendDurably({
          recipient: n.agentId,
          lookupWait: (message) => `Waiting for the hold owner: ${message}`,
          busyWait: (state) =>
            `Waiting for the hold owner to finish (${state.status})`,
          wait: (reason) => {
            const current = unchanged();
            if (current && current.error !== reason)
              this.store.putNotice({ ...current, error: reason });
          },
          gone: () => {
            const current = unchanged();
            if (current)
              this.store.putNotice({
                ...current,
                status: "superseded",
                error: "Hold owner thread is no longer available",
              });
          },
          confirm: () => {
            const current = unchanged();
            if (!current) return null;
            if (holdGone()) {
              this.store.putNotice({
                ...current,
                status: "superseded",
                error: "Hold was released before the prompt was delivered",
              });
              return null;
            }
            return current;
          },
          target: (current) => {
            const owner = this.store.task(current.taskId);
            return {
              agentId: current.agentId,
              id: current.id,
              text: current.text,
              sourceAgentId:
                owner.hostId === recipientHost
                  ? (owner.agentId ?? undefined)
                  : undefined,
            };
          },
          mark: (current, status, error) => {
            if (status === "intent") {
              this.store.putNotice({ ...current, error, status });
              return;
            }
            const latest = sending(current);
            if (latest) this.store.putNotice({ ...latest, error, status });
          },
        }),
      );
      if (sent === "paused") return;
    }
  }
  /**
   * nucleus#1417: one durable notice per hidden-row episode reaches the task's
   * planner through the ordinary notice path (intent before send, uncertain after
   * a failure, never resent blindly). The episode itself is the host pass's
   * record, so a notice the planner has not read yet stays pending and visible
   * and is delivered once the planner's turn ends — a failed presentation pass
   * never suppresses it. An episode that ended, a finished task or a superseded
   * record settles the notice without sending, and an owner change re-points a
   * pending one at the owner it would reach now.
   */
  async deliverRowHiddenNotices(scopedHost?: string) {
    if (!scopedHost) {
      const hosts = new Set(
        this.store
          .pendingNotices()
          .filter((n) => n.kind === "row_hidden")
          .flatMap((n) => {
            const host = this.store.task(n.taskId).hostId;
            return host ? [host] : [];
          }),
      );
      for (const host of hosts)
        await this.resolution.withHost(host, () =>
          this.deliverRowHiddenNotices(host),
        );
      return;
    }
    if (!this.adapter.notify || this.paused()) return;
    const ended = "The row is no longer hidden for this episode";
    const live = (taskId: string, id: string) => {
      const record = this.store.getMeta<RowHiddenEpisode>(rowHiddenKey(taskId));
      return Boolean(record && record.noticeId === id);
    };
    for (let n of this.store.pendingNotices()) {
      if (this.paused()) return;
      if (n.kind !== "row_hidden") continue;
      const task = this.store.task(n.taskId);
      if (task.hostId !== scopedHost) continue;
      if (n.status === "intent") {
        this.store.putNotice({
          ...n,
          status: "uncertain",
          error:
            "Restart during delivery; inspect the planner thread before resending",
        });
        continue;
      }
      if (
        task.removedAt ||
        task.phase === "done" ||
        task.phase === "cancelled" ||
        !live(task.id, n.id)
      ) {
        this.store.putNotice({ ...n, status: "superseded", error: ended });
        continue;
      }
      const target = noticeTarget(this.store, task, n);
      if (target === null) {
        if (n.error !== NO_ORIGIN_THREAD_WAIT)
          this.store.putNotice({ ...n, error: NO_ORIGIN_THREAD_WAIT });
        continue;
      }
      // The planner a pending notice would reach now, never the one it recorded
      // before an owner change; a settled one keeps the recipient it recorded.
      if (target !== n.agentId) {
        this.store.putNotice({ ...n, agentId: target, error: "" });
        continue;
      }
      const recipientHost =
        target === task.originAgentId || target === task.notificationAgentId
          ? task.originHostId
          : await this.resolution.identifyOriginHost(target);
      if (
        !recipientHost ||
        !this.resolution.withHost(recipientHost, () =>
          this.resolution.originHostAvailable(recipientHost),
        )
      ) {
        const error = recipientHost
          ? `Waiting for host ${recipientHost}`
          : "Waiting for a proven planner host";
        if (n.error !== error) this.store.putNotice({ ...n, error });
        continue;
      }
      const sent = await this.resolution.withHost(recipientHost, () =>
        this.sendDurably({
          recipient: target,
          lookupWait: (message) => `Waiting for the planner: ${message}`,
          busyWait: (state) =>
            `Waiting for the planner to finish (${state.status})`,
          wait: (reason) => {
            if (n.error !== reason)
              this.store.putNotice({ ...n, error: reason });
          },
          gone: () =>
            this.store.putNotice({
              ...n,
              status: "superseded",
              error: "The planner thread is no longer available",
            }),
          confirm: () => {
            const current = this.store
              .notices(n.taskId)
              .find((notice) => notice.id === n.id);
            if (!current || current.status !== "pending") return null;
            if (!live(current.taskId, current.id)) {
              this.store.putNotice({
                ...current,
                status: "superseded",
                error: ended,
              });
              return null;
            }
            return current;
          },
          target: (current) => ({
            agentId: current.agentId,
            id: current.id,
            text: current.text,
          }),
          mark: (current, status, error) => {
            const latest = this.store
              .notices(current.taskId)
              .find((notice) => notice.id === current.id);
            if (latest) this.store.putNotice({ ...latest, error, status });
          },
        }),
      );
      if (sent === "paused") return;
    }
  }
  /**
   * Spec 032 delivery: one durable notice per answered decision version reaches
   * the asking agent's thread. The notice id is deterministic, so a retry after a
   * failed or interrupted delivery can never become a second notice.
   */
  async deliverDecisionNotices() {
    await deliverDecisionNoticesPass({
      adapter: this.adapter,
      stopped: this.resolution.stopped(),
      store: this.store,
      resolution: this.resolution,
    });
  }
}
