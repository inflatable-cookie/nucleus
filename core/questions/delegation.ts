import { randomBytes } from "node:crypto";
import type { Profile, Task } from "../../shared/contracts";
import {
  awaitingProofTexts,
  isOperatorOrigin,
  taskPlanner,
  taskOwner,
} from "../../shared/contracts";
import { sameCallerIdentity } from "../../shared/agent-identity";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { demandRank, unavailableGroupNames } from "../../shared/pool";
import { currentBrief } from "../planning/brief";
import {
  offeredChoice,
  parseNativeDelegatedReply,
} from "./question-delegation";
import { plannerEscalations, type LadderEvent } from "./ladder";
import { askLifecycle } from "./agent-ask-events";
import type { Resolution } from "../resolution";
import { complexityBracket } from "../../shared/demand";
import { chooseProfile } from "../dispatch/routing";
import { plannerParticipantTicketPath } from "../dispatch/participant-tickets";
import { runTicketPath, writeRunTicket } from "../dispatch/agent-creation";
import {
  formatAgentId,
  nativeAgentId,
  parseAgentId,
  qualifyLegacyAgentId,
} from "../../shared/agent-identity";
import { hostKindOf, type IdentitySource } from "../../shared/host-kind";
import { onOwnerHost } from "../host/host-ports";

/** The selection failed before an intent or host call was made. */
export class DelegatedHostUnavailable extends Error {}

/**
 * The one reason a delivery window closes without a command answer. The advance
 * rule distinguishes it from an unknown delivery, so the writer and both readers
 * compare this name rather than its wording.
 */
export const NO_COMMAND_ANSWER_IN_WINDOW = "No command answer in the window";

/** Which planner rung a question is on: the task's own planner, or the project's. */
export type PlannerRungName = "task" | "project";

function escalationIdForQuestion(questionId: string): string {
  return questionId
    .replace(/^ns-decider-/, "")
    .replace(/^ns-escalation-(?:refusal-)?/, "")
    .replace(/-project$/, "");
}

/** One planner rung, with the message window its question travels on. */
export interface PlannerRung {
  agentId: string;
  rung: PlannerRungName;
}

/** One question to one delegate, under an answer window, on the `delegation:<id>` stream. */
export class Delegation {
  constructor(readonly resolution: Resolution) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  get profiles() {
    return this.resolution.profiles;
  }
  private recordCommandApplied(
    key: string,
    escalationId: string,
    answerEventId: number,
  ): void {
    if (
      this.store
        .eventsAll(key)
        .some(
          (event) =>
            event.id > answerEventId &&
            (event.kind === "delegated_command_applied" ||
              event.kind === "delegated_command_refused"),
        )
    )
      return;
    this.store.event(
      key,
      "delegated_command_applied",
      `${escalationId}: applied after answer event ${answerEventId}`,
    );
  }
  private recordCommandRefused(
    key: string,
    escalationId: string,
    message: string,
    answerEventId: number,
  ): void {
    if (
      this.store
        .eventsAll(key)
        .some(
          (event) =>
            event.id > answerEventId &&
            (event.kind === "delegated_command_applied" ||
              event.kind === "delegated_command_refused"),
        )
    )
      return;
    this.store.event(
      key,
      "delegated_command_refused",
      `${escalationId}: ${message}`.slice(0, 4000),
    );
  }
  get stopped() {
    return this.resolution.stopped;
  }
  get delegatedAnswerWaitMs() {
    return this.resolution.delegatedAnswerWaitMs;
  }

  /**
   * Name a replacement `question.answer` identity for the recipient. Helper-reporting
   * hosts re-issue the latest run ticket. MCP hosts with a recipient run do the same
   * so ticket-first CLI does not inherit a purged launch ticket; MCP hosts without a
   * run on this task clear `NUCLEUS_TICKET` so the host identity answers. Runs match
   * proven host and native identity, so a Paseo planner cannot inherit a T3 worker
   * ticket that shares the native id. Complete and ask keep refusing the released run.
   */
  private consultTicketRoute(
    task: Task,
    recipient: string,
    provenHost?: string,
  ):
    | { kind: "ticket"; helperPath: string; ticketPath: string }
    | { kind: "participant"; ticketPath: string }
    | { kind: "clear" }
    | undefined {
    if (!this.adapter.helperPath || !this.adapter.socketPath) return;
    const runs = provenHost
      ? this.store
          .runs(task.id)
          .filter(
            (run) => run.agentId === recipient && run.hostId === provenHost,
          )
      : [];
    const run =
      runs.find((candidate) => !candidate.released && !candidate.completion) ??
      runs.at(-1);
    if (!run) {
      const participant = plannerParticipantTicketPath(
        this.store,
        recipient,
        provenHost,
      );
      if (participant) return { kind: "participant", ticketPath: participant };
      if (
        this.adapter.reportingViaMcp === false &&
        (!provenHost || hostKindOf(provenHost) !== "t3code")
      )
        throw Error("Consult requires the recipient run ticket");
      return { kind: "clear" };
    }
    const token = randomBytes(32).toString("hex");
    this.store.setCredential(run.id, token);
    const paths = {
      helperPath: this.adapter.helperPath,
      socketPath: this.adapter.socketPath,
    };
    writeRunTicket(paths, task, run, token);
    return {
      kind: "ticket",
      helperPath: paths.helperPath,
      ticketPath: runTicketPath(paths, run.id),
    };
  }
  private quote(value: string) {
    return `'${value.replaceAll("'", "'\\''")}'`;
  }
  async requireHost(
    task: Task,
    recipient: string,
    role: "planner" | "reviewer",
  ): Promise<string> {
    const recorded =
      role === "reviewer"
        ? task.hostId
        : recipient === task.originAgentId ||
            recipient === task.notificationAgentId
          ? task.originHostId
          : undefined;
    const host =
      recorded ?? (await this.resolution.identifyOriginHost(recipient));
    const settled = await this.hostThroughBridge(
      host,
      recorded
        ? undefined
        : () => this.resolution.identifyOriginHost(recipient),
    );
    if (
      !settled ||
      !this.resolution.withHost(settled, () =>
        this.resolution.originHostAvailable(settled),
      )
    )
      throw new DelegatedHostUnavailable(
        "Delegated recipient host is unavailable or unknown",
      );
    return settled;
  }

  /**
   * A host-dependent call arriving just after a service roll waits, bounded,
   * for the plugin bridge to answer again instead of refusing as unavailable
   * (roll-recovery contract): only a bridge still unavailable after the bound
   * refuses, and the re-check reads live availability, never the wait's own
   * answer. A recorded host is re-checked as is; an identified one is
   * identified again, because the roll window is exactly when inventories
   * answer ambiguously.
   */
  private async hostThroughBridge(
    host: string | undefined,
    reidentify?: () => Promise<string | undefined>,
  ): Promise<string | undefined> {
    const available = () =>
      Boolean(
        host &&
          this.resolution.withHost(host, () =>
            this.resolution.originHostAvailable(host),
          ),
      );
    if (available()) return host;
    if (!this.resolution.awaitHostBridge) return host;
    await this.resolution.awaitHostBridge(this.resolution.hostBridgeWaitMs);
    return reidentify ? await reidentify() : host;
  }

  delegatePrompt(
    task: Task,
    id: string,
    prompt: string,
    recipient?: string,
    hostId?: string,
  ): string {
    const json = JSON.stringify({
      questionId: id,
      answer: "<answer or exact choice>",
      reason: "<one line>",
    });
    const provenHost = hostId ?? this.delegatedDelivery(id)?.hostId;
    const route = recipient
      ? this.consultTicketRoute(task, recipient, provenHost)
      : undefined;
    const command =
      route?.kind === "ticket" || route?.kind === "participant"
        ? `NUCLEUS_TICKET=${this.quote(route.ticketPath)} nucleus question.answer -`
        : route?.kind === "clear"
          ? "NUCLEUS_TICKET= nucleus question.answer -"
          : "nucleus question.answer -";
    const helper =
      route?.kind === "ticket" && this.adapter.reportingViaMcp === false
        ? `\nOn a host without per-thread MCP, the packaged nucleus helper with this run's ticket is the same command:\nNUCLEUS_TICKET=${this.quote(route.ticketPath)} NUCLEUS_CONTINUATION_TICKET= nucleus helper report answer <<'JSON'\n${json}\nJSON`
        : "";
    return `Task: ${task.reference ?? task.id} — ${task.title}\nQuestion id: ${id}\n${prompt}\nAnswer with this command; write nothing else in this thread. For operator-only matters set "decision":"operator" instead of answer.\n${command} <<'JSON'\n${json}\nJSON${helper}${provenHost ? "\nTo validate without recording an answer, add --dry-run to question.answer (or set dryRun: true in the helper JSON)." : ""}`;
  }
  openDelegatedQuestion(
    task: Task,
    id: string,
    recipient: string,
    prompt: string,
    timeoutMs: number,
    role: string,
    hostId?: string,
    rung?: PlannerRungName,
    choices?: readonly string[],
    retainAfterDeadline?: boolean,
  ): void {
    const qualified = parseAgentId(recipient);
    if (qualified && hostId && qualified.hostId !== hostId)
      throw Error("Delegated recipient belongs to a different host");
    recipient = qualified?.nativeAgentId ?? recipient;
    this.store.event(
      `delegation:${id}`,
      "delegated_delivery",
      JSON.stringify({
        taskId: task.id,
        recipient,
        role,
        prompt,
        ...(hostId
          ? { hostId, recipientRef: qualifyLegacyAgentId(recipient, hostId) }
          : {}),
        ...(rung ? { rung } : {}),
        ...(choices ? { choices } : {}),
        ...(retainAfterDeadline ? { retainAfterDeadline } : {}),
        deadline: Date.now() + Math.min(timeoutMs, this.delegatedAnswerWaitMs),
      }),
    );
  }
  /** A restart may resume observation, never delivery. Unknown sends remain fenced. */
  delegatedDelivery(id: string): {
    taskId: string;
    recipient: string;
    role: string;
    deadline: number;
    hostId?: string;
    recipientRef?: string;
    retainAfterDeadline?: boolean;
    rung?: PlannerRungName;
  } | null {
    const event = this.store
      .eventsAll(`delegation:${id}`)
      .findLast((event) => event.kind === "delegated_delivery");
    return event ? JSON.parse(event.detail) : null;
  }
  /** A task target is safe only when it selects one live question for this recipient. */
  questionForTask(identity: string, caller: string): string {
    const taskId = this.store.resolveTaskId(identity);
    this.store.task(taskId);
    const identityCaller = parseAgentId(caller);
    const nativeCaller = identityCaller?.nativeAgentId ?? caller;
    const rows = this.store.delegatedDeliveryStreams(taskId);
    const ids = rows
      .map((stream) => stream.replace(/^delegation:/, ""))
      .filter((id) => {
        const delivery = this.delegatedDelivery(id);
        const events = this.store.eventsAll(`delegation:${id}`);
        return (
          delivery &&
          (delivery.recipient === nativeCaller ||
            delivery.recipient === caller) &&
          (!identityCaller || delivery.hostId === identityCaller.hostId) &&
          (delivery.retainAfterDeadline || delivery.deadline >= Date.now()) &&
          !events.some((event) =>
            ["delegated_answer", "delegated_closed"].includes(event.kind),
          )
        );
      });
    if (ids.length !== 1)
      throw Error(
        ids.length
          ? "More than one open question for this task and caller; pass questionId"
          : "No open question for this task and caller; pass questionId to inspect an existing answer",
      );
    return ids[0]!;
  }
  /** A raw caller name cannot identify a host when inventories are ambiguous. */
  async answerFromHost(
    input: {
      questionId: string;
      answer?: string;
      choice?: string;
      reason: string;
      decision?: "operator";
      overtakes?: string[];
      dryRun?: boolean;
    },
    caller: string,
    identitySource?: IdentitySource,
  ) {
    const delivery = this.delegatedDelivery(input.questionId);
    const qualified = parseAgentId(caller);
    const nativeCaller = qualified?.nativeAgentId ?? caller;
    if (!delivery || ![nativeCaller, caller].includes(delivery.recipient))
      throw Error(
        "Only the delegated recipient thread may answer this question",
      );
    // The answering thread's own proven host is evidence about that identity, so
    // a host with no part in this answer cannot make it ambiguous.
    const identify = () =>
      qualified
        ? Promise.resolve(qualified.hostId)
        : this.resolution.identifyOriginHost(caller, identitySource);
    const observedHost = await this.hostThroughBridge(
      await identify(),
      identify,
    );
    if (
      !observedHost ||
      !this.resolution.withHost(observedHost, () =>
        this.resolution.originHostAvailable(observedHost),
      )
    )
      throw new DelegatedHostUnavailable(
        "Delegated answer host is unavailable or ambiguous",
      );
    const known =
      this.store.getMeta<Array<{ id: string }>>("hostRegistry") ?? [];
    const recordedHost =
      delivery.hostId ?? (known.length === 1 ? known[0]?.id : undefined);
    if (!recordedHost || recordedHost !== observedHost)
      throw new DelegatedHostUnavailable("Delegated answer host is not proven");
    if (
      delivery.recipientRef &&
      nativeAgentId(delivery.recipientRef, recordedHost) !== nativeCaller
    )
      throw Error(
        "Delegated recipient identity conflicts with its recorded host",
      );
    if (
      JSON.stringify(this.delegatedDelivery(input.questionId)) !==
      JSON.stringify(delivery)
    )
      throw Error("Delegated recipient changed during host verification");
    return this.answerDelegatedQuestion(
      input,
      qualified ? caller : nativeCaller,
    );
  }
  /** Ordered windows: an observed miss advances to an unstarted next delegate; unknown sends never do. */
  recoverableDelegation(ids: string[], advance = true): boolean {
    const windows = ids.map((id) => {
      const events = this.store.eventsAll(`delegation:${id}`);
      return {
        delivered: events.some((event) => event.kind === "delegated_delivery"),
        answered: events.some((event) => event.kind === "delegated_answer"),
        closed: events.findLast((event) => event.kind === "delegated_closed"),
      };
    });
    return windows.some(
      (window, index) =>
        window.answered ||
        (window.delivered && !window.closed) ||
        (advance &&
          window.delivered &&
          window.closed?.detail === NO_COMMAND_ANSWER_IN_WINDOW &&
          index < windows.length - 1 &&
          windows.slice(index + 1).every((next) => !next.delivered)),
    );
  }
  /**
   * Ticket-bound `question.answer`: authenticate the recipient run, then record
   * the receipt as that run's agent on its proven host. Released reviewer runs
   * may still answer; `askBinding`'s current-run gate does not apply.
   */
  answerDelegatedQuestionFromTicket(
    input: {
      taskId: string;
      runId: string;
      questionId: string;
      answer?: string;
      choice?: string;
      reason: string;
      decision?: "operator";
      overtakes?: string[];
      dryRun?: boolean;
    },
    token: string,
  ) {
    this.store.authenticate(input.runId, token);
    const run = this.store.run(input.runId);
    const task = this.store.task(input.taskId);
    if (run ? run.taskId !== task.id : task.runId !== input.runId)
      throw Error("Stale report: task and run identity do not match");
    const caller = run?.agentId ?? task.agentId;
    if (!caller) throw Error("No agent bound to this reporting run");
    const delivery = this.delegatedDelivery(input.questionId);
    if (!delivery) throw Error("No delegated question with this id");
    if (delivery.taskId !== task.id)
      throw Error("Stale report: task and run identity do not match");
    const known =
      this.store.getMeta<Array<{ id: string }>>("hostRegistry") ?? [];
    const recordedHost =
      delivery.hostId ?? (known.length === 1 ? known[0]?.id : undefined);
    const runHost = run?.hostId ?? task.hostId;
    if (!recordedHost || !runHost || recordedHost !== runHost)
      throw new DelegatedHostUnavailable("Delegated answer host is not proven");
    if (delivery.recipient !== caller)
      throw Error(
        "Only the delegated recipient thread may answer this question",
      );
    if (
      delivery.recipientRef &&
      nativeAgentId(delivery.recipientRef, recordedHost) !== caller
    )
      throw Error(
        "Delegated recipient identity conflicts with its recorded host",
      );
    return this.answerDelegatedQuestion(
      {
        questionId: input.questionId,
        answer: input.answer,
        choice: input.choice,
        reason: input.reason,
        decision: input.decision,
        overtakes: input.overtakes,
        dryRun: input.dryRun,
      },
      formatAgentId(runHost, caller),
    );
  }
  answerDelegatedQuestion(
    input: {
      questionId: string;
      answer?: string;
      choice?: string;
      reason: string;
      decision?: "operator";
      overtakes?: string[];
      dryRun?: boolean;
    },
    caller: string,
  ) {
    const key = `delegation:${input.questionId}`;
    const events = this.store.eventsAll(key);
    const delivery = events.findLast(
      (event) => event.kind === "delegated_delivery",
    );
    if (!delivery) throw Error("No delegated question with this id");
    const authority = JSON.parse(delivery.detail) as {
      taskId: string;
      recipient: string;
      role: string;
      prompt: string;
      choices?: string[];
      retainAfterDeadline?: boolean;
      deadline: number;
      hostId?: string;
    };
    const qualified = parseAgentId(caller);
    const recordedHost =
      authority.hostId ??
      (this.store.getMeta<Array<{ id: string }>>("hostRegistry")?.length === 1
        ? this.store.getMeta<Array<{ id: string }>>("hostRegistry")?.[0]?.id
        : undefined);
    if (
      !caller ||
      ![caller, qualified?.nativeAgentId].includes(authority.recipient) ||
      (qualified && qualified.hostId !== recordedHost)
    )
      throw Error(
        "Only the delegated recipient thread may answer this question",
      );
    const isEscalation =
      input.questionId.startsWith("ns-escalation-") ||
      input.questionId.startsWith("ns-decider-");
    const choices =
      authority.choices ??
      authority.prompt
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2));
    const submittedAnswer = (input.answer ?? input.choice)?.trim();
    const answer =
      (submittedAnswer &&
        offeredChoice(choices, submittedAnswer, isEscalation)) ??
      submittedAnswer;
    const normalizedInput =
      answer === submittedAnswer
        ? input
        : input.choice
          ? { ...input, choice: answer }
          : { ...input, answer };
    const recorded = events.findLast(
      (event) => event.kind === "delegated_answer",
    );
    let correctingRefusal = false;
    if (recorded) {
      const receipt = JSON.parse(recorded.detail) as {
        questionId: string;
        caller: string;
        answer?: string;
        reason: string;
        decision?: "operator";
        overtakes?: string[];
      };
      const escalationId = escalationIdForQuestion(input.questionId);
      const outcome = events.findLast(
        (event) =>
          event.id > recorded.id &&
          (event.kind === "delegated_command_applied" ||
            event.kind === "delegated_command_refused"),
      );
      if (input.dryRun && outcome?.kind !== "delegated_command_refused")
        throw Error("This question already has an answer");
      if (outcome?.kind === "delegated_command_applied") return receipt;
      if (outcome?.kind === "delegated_command_refused") {
        // An uncertain owner action is not a definite refusal: another answer
        // could repeat an effect whose delivery is still unknown.
        if (
          this.store
            .eventsAll(authority.taskId)
            .some(
              (event) =>
                event.id > recorded.id &&
                event.kind === "planner_escalation_action_uncertain" &&
                event.detail.startsWith(`${escalationId}:`),
            )
        )
          return Promise.reject(
            Error(outcome.detail.slice(outcome.detail.indexOf(":") + 2)),
          );
        if (
          answer === receipt.answer &&
          input.reason?.trim() === receipt.reason &&
          input.decision === receipt.decision
        )
          return Promise.reject(
            Error(outcome.detail.slice(outcome.detail.indexOf(":") + 2)),
          );
        // The same delegated recipient can correct a definite refusal even if
        // the original answer window elapsed while the direction was deferred.
        correctingRefusal = true;
      } else {
        if (!isEscalation) return receipt;
        const taskEvents = this.store.eventsAll(authority.taskId);
        const hasEscalation = taskEvents.some(
          (event) =>
            event.kind === "planner_escalation" &&
            event.detail.startsWith(`${escalationId}:`),
        );
        if (!hasEscalation) {
          const message = `Escalation ${escalationId} is no longer recorded; the answer was not applied. Read task next before answering again`;
          this.store.event(
            key,
            "delegated_command_refused",
            `${escalationId}: ${message}`.slice(0, 4000),
          );
          return Promise.reject(Error(message));
        }
        return this.recoverRecordedEscalationAnswer(
          key,
          authority,
          receipt,
          escalationId,
          input.questionId,
          recorded.id,
        );
      }
    }
    if (authority.retainAfterDeadline) {
      const task = this.store.task(authority.taskId);
      const ask = askLifecycle(
        this.store.eventsAll(task.id),
        input.questionId.replace(/^ns-agent-ask-reviewer-/, ""),
      );
      if (
        task.removedAt ||
        ["done", "cancelled"].includes(task.phase) ||
        ask?.superseded ||
        ask?.answered
      )
        throw Error("This review consult is already settled");
    }
    if (
      !correctingRefusal &&
      (events.some((event) => event.kind === "delegated_closed") ||
        (!authority.retainAfterDeadline && Date.now() > authority.deadline))
    )
      throw Error("This delegated answer window has closed");
    const reason = input.reason?.trim();
    if (!reason || /[\r\n]/.test(reason) || reason.length > 500)
      throw Error("A one-line reason is required (up to 500 characters)");
    if (
      input.decision !== "operator" &&
      (!answer || answer.length > 4000 || /[\r\n]/.test(answer))
    )
      throw Error(
        "An answer or choice is required (one line, up to 4000 characters)",
      );
    if (
      input.decision !== "operator" &&
      (input.choice ||
        (choices.length && input.questionId.startsWith("queue-delegate-"))) &&
      !choices.includes(
        authority.role === "decider" && input.choice
          ? submittedAnswer!
          : answer!,
      )
    )
      throw Error(
        "Choice must match an offered choice. Use answer for a free response and --dry-run to validate it.",
      );
    if (authority.role === "decider") {
      const normalize = (value: string) =>
        value
          .toLowerCase()
          .replace(/\s+/g, " ")
          .replace(/[.!?]+$/, "");
      const placeholder = (value: string) =>
        /^(?:test(?:ing)?(?: (?:answer|reason|this command))?|probe|placeholder|dummy|sample|example|todo|tbd|n\s*\/?\s*a|none|null|foo|bar|lorem ipsum|answer|reason|your answer|your reason|<[^>]+>)$/.test(
          normalize(value),
        );
      if (
        placeholder(reason) ||
        (input.answer &&
          answer &&
          (placeholder(answer) || normalize(answer) === normalize(reason)))
      )
        throw Error(
          "Give a substantive answer and a distinct one-line reason. Use question.answer --dry-run to validate without submitting.",
        );
    }
    const escalationId = escalationIdForQuestion(input.questionId);
    const taskEvents = isEscalation
      ? this.store.eventsAll(authority.taskId)
      : [];
    const escalation = isEscalation
      ? plannerEscalations(taskEvents as LadderEvent[]).find(
          (item) => item.id === escalationId,
        )
      : undefined;
    if (escalation?.answered)
      throw Error(
        `Escalation ${escalationId} is already settled; read next again`,
      );
    const receipt = {
      questionId: input.questionId,
      caller,
      answer,
      reason,
      ...(input.decision ? { decision: input.decision } : {}),
      ...(authority.role === "planner" && input.overtakes?.length
        ? { overtakes: [...new Set(input.overtakes)].slice(0, 100) }
        : {}),
    };
    if (input.dryRun) return { ...receipt, status: "validated" as const };
    this.store.event(key, "delegated_answer", JSON.stringify(receipt));
    const receiptEventId = this.store
      .eventsAll(key)
      .findLast((event) => event.kind === "delegated_answer")!.id;
    this.store.event(
      authority.taskId,
      "delegated_command_answered",
      `${input.questionId}: ${caller}`,
    );
    if (escalation) {
      return this.applyEscalationAnswer(
        authority.taskId,
        normalizedInput,
        caller,
        authority.role,
        reason,
      ).then(
        () => {
          if (
            this.deferredEscalation(
              authority.taskId,
              escalationId,
              input.questionId,
            )
          )
            return { ...receipt, status: "pending" as const };
          this.recordCommandApplied(key, escalationId, receiptEventId);
          return receipt;
        },
        (error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.recordCommandRefused(key, escalationId, message, receiptEventId);
          throw error;
        },
      );
    }
    return receipt;
  }
  private deferredEscalation(
    taskId: string,
    escalationId: string,
    questionId: string,
  ): boolean {
    const marker = this.store.task(taskId).resolution.deferredVerb?.input
      .__workerAsk as
      | { escalationId?: string; questionId?: string }
      | undefined;
    return (
      marker?.escalationId === escalationId && marker.questionId === questionId
    );
  }
  private async recoverRecordedEscalationAnswer(
    key: string,
    authority: {
      taskId: string;
      recipient: string;
      role: string;
      prompt: string;
      deadline: number;
      hostId?: string;
    },
    receipt: {
      questionId: string;
      caller: string;
      answer?: string;
      reason: string;
      decision?: "operator";
      overtakes?: string[];
    },
    escalationId: string,
    questionId: string,
    recordedId: number,
  ) {
    const taskEvents = this.store.eventsAll(authority.taskId);
    if (this.deferredEscalation(authority.taskId, escalationId, questionId))
      return { ...receipt, status: "pending" as const };
    const inProcess =
      await this.resolution.escalationSettlement.awaitDelegatedEscalationSettlement(
        authority.taskId,
        escalationId,
        questionId,
      );
    if (inProcess?.status === "applied") {
      this.recordCommandApplied(key, escalationId, recordedId);
      return receipt;
    }
    if (inProcess?.status === "refused") {
      const message = `Escalation ${escalationId} answer was not applied: ${inProcess.reason}`;
      this.recordCommandRefused(key, escalationId, message, recordedId);
      return Promise.reject(Error(message));
    }
    const refused = taskEvents.findLast(
      (event) =>
        event.kind === "planner_escalation_answer_refused" &&
        event.detail.startsWith(`${escalationId}:`) &&
        event.id > recordedId,
    );
    if (refused) {
      const message = refused.detail.slice(refused.detail.indexOf(":") + 2);
      this.recordCommandRefused(key, escalationId, message, recordedId);
      return Promise.reject(Error(message));
    }
    if (
      taskEvents.some(
        (event) =>
          (event.kind === "planner_escalation_applied" ||
            event.kind === "planner_escalation_resolved") &&
          event.detail.startsWith(`${escalationId}:`) &&
          event.id > recordedId,
      ) ||
      this.resolution.ladder.operatorDecisionApplied(
        authority.taskId,
        escalationId,
      )
    ) {
      this.recordCommandApplied(key, escalationId, recordedId);
      return receipt;
    }
    const reconciled =
      this.resolution.escalationSettlement.reconcileDelegatedEscalationAnswer(
        authority.taskId,
        escalationId,
        questionId,
        recordedId,
      );
    if (reconciled === "pending")
      return { ...receipt, status: "pending" as const };
    if (reconciled === "applied") {
      this.recordCommandApplied(key, escalationId, recordedId);
      return receipt;
    }
    if (reconciled === "unknown") {
      const message = `Escalation ${escalationId} answer was not confirmed as applied because its owner action outcome is unknown; Nucleus did not replay it. Read task next and reconcile its effects before answering again.`;
      this.store.event(
        authority.taskId,
        "planner_escalation_action_uncertain",
        `${escalationId}: ${message}`.slice(0, 4000),
      );
      this.store.event(
        authority.taskId,
        "planner_escalation_answer_refused",
        `${escalationId}: ${message}`.slice(0, 4000),
      );
      this.resolution.waiting(
        this.store.task(authority.taskId),
        `Escalation ${escalationId} is unresolved: ${message}`,
        "escalated",
      );
      this.recordCommandRefused(key, escalationId, message, recordedId);
      return Promise.reject(Error(message));
    }
    if (
      plannerEscalations(taskEvents as LadderEvent[]).find(
        (item) => item.id === escalationId,
      )?.answered
    ) {
      const message = `Escalation ${escalationId} is already settled; read next again`;
      this.store.event(
        key,
        "delegated_command_refused",
        `${escalationId}: ${message}`,
      );
      return Promise.reject(Error(message));
    }
    // A service roll can preserve the delegated answer intent while interrupting
    // its ordinary owner action. Do not replay that intent as a successful
    // answer until the replacement has applied it or recorded a refusal.
    const choices = authority.prompt
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2));
    const replay = {
      questionId,
      ...(receipt.answer !== undefined
        ? choices.includes(receipt.answer)
          ? { choice: receipt.answer }
          : { answer: receipt.answer }
        : {}),
      reason: receipt.reason,
      ...(receipt.decision ? { decision: receipt.decision } : {}),
      ...(receipt.overtakes ? { overtakes: receipt.overtakes } : {}),
    };
    return this.applyEscalationAnswer(
      authority.taskId,
      replay,
      receipt.caller,
      authority.role,
      receipt.reason,
    ).then(
      () => {
        if (this.deferredEscalation(authority.taskId, escalationId, questionId))
          return { ...receipt, status: "pending" as const };
        this.recordCommandApplied(key, escalationId, recordedId);
        return receipt;
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.recordCommandRefused(key, escalationId, message, recordedId);
        throw error;
      },
    );
  }
  private async applyEscalationAnswer(
    taskId: string,
    input: {
      questionId: string;
      answer?: string;
      choice?: string;
      decision?: "operator";
    },
    caller: string,
    role: string,
    reason: string,
  ) {
    const escalationId = escalationIdForQuestion(input.questionId);
    try {
      if (input.decision === "operator") {
        this.resolution.ladder.classifyEscalationToOperator(
          this.store.task(taskId),
          escalationId,
          reason,
          `${role} ${caller}`,
        );
      } else {
        const answer = `${input.choice ?? input.answer!} — ${reason}`;
        const refusal =
          await this.resolution.escalationSettlement.applyDelegatedEscalationAnswer(
            taskId,
            escalationId,
            input.questionId,
            answer,
            `${role} ${caller}`,
          );
        if (refusal) throw Error(refusal);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `Escalation ${escalationId} answer was not applied: ${detail}. Read task next, then answer this same question with a corrected choice or reason.`;
      this.store.event(
        taskId,
        "planner_escalation_answer_refused",
        `${escalationId}: ${message}`.slice(0, 4000),
      );
      throw Error(message);
    }
  }
  async waitDelegatedAnswer(
    id: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const key = `delegation:${id}`;
    while (true) {
      const events = this.store.eventsAll(key);
      const receipt = events.findLast(
        (event) => event.kind === "delegated_answer",
      );
      if (receipt) {
        const value = JSON.parse(receipt.detail) as {
          answer?: string;
          reason: string;
          decision?: string;
          overtakes?: string[];
        };
        const delivered = events.findLast(
          (event) => event.kind === "delegated_delivery",
        );
        const taskId =
          delivered &&
          (JSON.parse(delivered.detail) as { taskId: string }).taskId;
        const escalationId = escalationIdForQuestion(id);
        if (
          (id.startsWith("ns-escalation-") || id.startsWith("ns-decider-")) &&
          taskId &&
          this.store
            .eventsAll(taskId)
            .some(
              (event) =>
                event.kind === "planner_escalation" &&
                event.detail.startsWith(`${escalationId}:`),
            )
        ) {
          const answerer = JSON.parse(receipt.detail) as { caller: string };
          try {
            await this.answerDelegatedQuestion(
              {
                questionId: id,
                ...(value.answer ? { answer: value.answer } : {}),
                ...(value.decision === "operator"
                  ? { decision: "operator" as const }
                  : {}),
                reason: value.reason,
                ...(value.overtakes ? { overtakes: value.overtakes } : {}),
              },
              answerer.caller,
            );
          } catch (error) {
            const refused = this.store
              .eventsAll(key)
              .some((event) => event.kind === "delegated_command_refused");
            if (!refused) throw error;
            // The CLI caller already received the refusal. Return the recorded
            // answer to the route so it can ask for a valid replacement choice.
          }
        }
        // Existing route parsers consume this serialization of structured command input only.
        return [
          value.decision === "operator"
            ? "Decision: operator"
            : `Answer: ${value.answer}\nChoice: ${value.answer}`,
          `Reason: ${value.reason}`,
          ...(value.overtakes
            ? [`Overtakes: ${value.overtakes.join(",")}`]
            : []),
        ].join("\n");
      }
      const delivery = events.findLast(
        (event) => event.kind === "delegated_delivery",
      );
      if (this.stopped())
        throw Error(
          "Delegated observation stopped; retain the delivery and answer window",
        );
      if (events.some((event) => event.kind === "delegated_closed"))
        return null;
      if (
        signal.aborted ||
        !delivery ||
        Date.now() >= JSON.parse(delivery.detail).deadline
      )
        break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, this.delegatedAnswerWaitMs)),
      );
    }
    if (!this.delegatedDelivery(id)?.retainAfterDeadline)
      this.store.event(key, "delegated_closed", NO_COMMAND_ANSWER_IN_WINDOW);
    return null;
  }
  async askBound(
    task: Task,
    recipient: string,
    input: {
      prompt: string;
      signal: AbortSignal;
      timeoutMs: number;
      messageId: string;
      sourceAgentId?: string;
      onIntent?: () => void;
      rung?: PlannerRungName;
      choices?: readonly string[];
      retainAfterDeadline?: boolean;
    },
    role: "planner" | "reviewer",
  ): Promise<string | null> {
    const existing = this.resolution.delegatedDelivery(input.messageId);
    const hostId = existing
      ? undefined
      : await this.requireHost(task, recipient, role);
    if (
      !existing &&
      !this.resolution.withHost(hostId!, () =>
        role === "planner" ? this.adapter.askPlanner : this.adapter.askReviewer,
      )
    )
      return null;
    if (!existing) {
      // Task 1109: a planner on a host without per-thread identity needs its ticket
      // before the question names it. Issuance is a convenience for the answer; a
      // failed issuance is recorded and the question keeps its ordinary host identity.
      if (role === "planner")
        await this.resolution
          .ensurePlannerTicket?.(recipient, hostId!)
          .catch((error) => {
            this.store.event(
              `delegation:${input.messageId}`,
              "delegated_planner_ticket_failed",
              error instanceof Error ? error.message : String(error),
            );
          });
      this.openDelegatedQuestion(
        task,
        input.messageId,
        recipient,
        input.prompt,
        input.timeoutMs,
        role,
        hostId,
        input.rung,
        input.choices,
        input.retainAfterDeadline,
      );
      input.onIntent?.();
    }
    try {
      if (!existing) {
        await this.resolution.withHost(hostId!, () => {
          const send =
            role === "planner"
              ? this.adapter.askPlanner
              : this.adapter.askReviewer;
          if (!send) throw Error("Host cannot send delegated questions");
          const recorded = this.store
            .eventsAll(`delegation:${input.messageId}`)
            .findLast((event) => event.kind === "delegated_delivery");
          const ref =
            recorded &&
            (JSON.parse(recorded.detail) as { recipientRef?: string })
              .recipientRef;
          if (!ref)
            throw Error("Delegated recipient identity was not recorded");
          const recipient = nativeAgentId(ref, hostId!);
          const {
            onIntent: _onIntent,
            choices: _choices,
            retainAfterDeadline: _retain,
            ...sendInput
          } = input;
          return send.call(this.adapter, recipient, {
            ...sendInput,
            sourceAgentId:
              task.hostId === hostId
                ? (input.sourceAgentId ?? task.agentId ?? undefined)
                : undefined,
            prompt: this.resolution.delegatePrompt(
              task,
              input.messageId,
              input.prompt,
              recipient,
              hostId,
            ),
          });
        });
        if (this.stopped())
          throw Error(
            "Delegated observation stopped; retain the delivery and answer window",
          );
        this.store.event(
          `delegation:${input.messageId}`,
          "delegated_sent",
          "Host send completed",
        );
      }
      const text = await this.resolution.waitDelegatedAnswer(
        input.messageId,
        input.signal,
      );
      // An intent surviving a restart proves neither delivery nor a known miss.
      // An authenticated receipt is sufficient; otherwise only an observed send
      // can turn the expired answer window into permission to advance.
      if (
        !text &&
        existing &&
        !this.store
          .eventsAll(`delegation:${input.messageId}`)
          .some((event) => event.kind === "delegated_sent")
      )
        throw Error(
          "Previous delegate delivery was not observed; never resend",
        );
      if (role === "reviewer" && text)
        return parseNativeDelegatedReply(text)?.kind === "answer"
          ? (parseNativeDelegatedReply(text) as { answer: string }).answer
          : null;
      return text;
    } catch (error) {
      if (this.stopped()) throw error;
      if (
        this.store
          .eventsAll(`delegation:${input.messageId}`)
          .some((event) => event.kind === "delegated_answer")
      ) {
        const text = await this.resolution.waitDelegatedAnswer(
          input.messageId,
          input.signal,
        );
        const reply =
          role === "reviewer" ? parseNativeDelegatedReply(text) : null;
        return role === "reviewer"
          ? reply?.kind === "answer"
            ? reply.answer
            : null
          : text;
      }
      this.store.event(
        `delegation:${input.messageId}`,
        "delegated_closed",
        "Delivery outcome unknown; never resend",
      );
      throw error;
    }
  }
  /**
   * A decider is archived after its window, on the decider task's own host. A
   * failed archive is recorded, so the host keeps a visible orphan instead of the
   * delegation ledger losing it.
   */
  private async archiveDecider(
    task: Task,
    id: string,
    agentId: string,
  ): Promise<void> {
    try {
      await onOwnerHost(this.resolution, task, () =>
        this.resolution.host.archiveAgent(agentId),
      );
    } catch (error) {
      this.store.event(
        `delegation:${id}`,
        "delegated_decider_archive_failed",
        `${agentId}: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          4000,
        ),
      );
    }
  }
  async deciderBound(
    task: Task,
    input: {
      prompt: string;
      profile: Profile | null;
      signal: AbortSignal;
      timeoutMs: number;
      decisionId: string;
      sourceAgentId?: string;
      choices?: readonly string[];
    },
  ): Promise<{ agentId: string; text: string | null }> {
    const id = `ns-decider-${input.decisionId}`;
    const existing = this.resolution.delegatedDelivery(id);
    if (existing)
      return {
        agentId: existing.recipient,
        text: await this.resolution.waitDelegatedAnswer(id, input.signal),
      };
    if (!input.profile) throw Error("No eligible decider profile");
    if (
      !task.hostId ||
      !this.resolution.withHost(task.hostId, () =>
        this.resolution.originHostAvailable(task.hostId),
      )
    )
      throw new DelegatedHostUnavailable(
        "Decider host is unavailable or unknown",
      );
    const created = await this.resolution.withHost(task.hostId, () =>
      this.adapter.runDecider!(task, {
        profile: input.profile!,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        decisionId: input.decisionId,
      }),
    );
    this.openDelegatedQuestion(
      task,
      id,
      created.agentId,
      input.prompt,
      input.timeoutMs,
      "decider",
      task.hostId,
      undefined,
      input.choices,
    );
    try {
      await this.resolution.withHost(task.hostId, () =>
        this.adapter.askPlanner!(created.agentId, {
          ...input,
          sourceAgentId: input.sourceAgentId ?? task.agentId ?? undefined,
          messageId: id,
          prompt: this.resolution.delegatePrompt(
            task,
            id,
            input.prompt,
            created.agentId,
            task.hostId,
          ),
        }),
      );
      return {
        agentId: created.agentId,
        text: await this.resolution.waitDelegatedAnswer(id, input.signal),
      };
    } catch (error) {
      if (this.stopped()) throw error;
      if (
        this.store
          .eventsAll(`delegation:${id}`)
          .some((event) => event.kind === "delegated_answer")
      )
        return {
          agentId: created.agentId,
          text: await this.resolution.waitDelegatedAnswer(id, input.signal),
        };
      this.store.event(
        `delegation:${id}`,
        "delegated_closed",
        "Delivery outcome unknown; never resend",
      );
      await this.archiveDecider(task, id, created.agentId);
      throw error;
    }
  }
  /** A task's own planner is the thread its brief named or its owner. */
  async taskPlannerFor(task: Task): Promise<PlannerRung | null> {
    return (await this.taskPlannerRoute(task)).rung;
  }

  private async taskPlannerRoute(
    task: Task,
  ): Promise<{ rung: PlannerRung | null; issue?: string }> {
    const planner = taskPlanner(task);
    if (!planner || isOperatorOrigin(planner)) return { rung: null };
    const originHost =
      planner === task.originAgentId || planner === task.notificationAgentId
        ? task.originHostId
        : undefined;
    const state = await this.resolution.plannerPresence.threadRoute(
      planner,
      originHost,
    );
    // A task's own planner that cannot be confirmed stays an issue, as before; only the project shortlist tolerates unverified reads.
    if (state.kind === "unroutable" || state.kind === "unverified")
      return { rung: null, issue: state.detail };
    return {
      rung: state.kind === "gone" ? null : { agentId: planner, rung: "task" },
    };
  }

  /** An unresolved identity remains assigned and visible while the next planner is tried. */
  async plannerRungsFor(
    task: Task,
  ): Promise<{ rungs: PlannerRung[]; projectFailed: boolean; issue?: string }> {
    const own = await this.taskPlannerRoute(task);
    if (own.issue) return { rungs: [], projectFailed: false, issue: own.issue };
    const { planner, failed, issue } = await this.projectPlannerFor(task);
    const rungs = own.rung ? [own.rung] : [];
    if (
      planner &&
      !rungs.some((rung) => sameCallerIdentity(rung.agentId, planner))
    )
      rungs.push({ agentId: planner, rung: "project" });
    return {
      rungs,
      projectFailed: failed,
      issue:
        [...new Set([own.issue, issue].filter(Boolean))].join(" ") || undefined,
    };
  }

  async projectPlannerFor(
    task: Task,
  ): Promise<{ planner: string | null; failed: boolean; issue?: string }> {
    const project = this.store.projectFor(
      task.repoPath,
      normalizeRepositoryOrigin(task.repository ?? ""),
    );
    if (!project) return { planner: null, failed: false };
    const { thread } = await this.resolution.responsibleThread(project);
    return { planner: thread?.agentId ?? null, failed: false };
  }

  /**
   * Deciders use automatic selection at the task's own bracket
   * (`complexityBracket`, nucleus#1362): the coordinator's Mechanical demand
   * cannot authorize a weaker decider. Availability is the store's typed rows through the
   * shared group rule, never a decode of the durable table here.
   */
  deciderProfile(task: Task): Profile | null {
    const unavailable = unavailableGroupNames(this.store.availability());
    const profiles = this.profiles().filter(
      (profile) => profile.model !== "default",
    );
    const tier = complexityBracket(task.complexity);
    const pool = this.store
      .pool()
      .filter(
        (entry) => demandRank(entry.capability ?? "worker") >= demandRank(tier),
      );
    return (
      chooseProfile(
        {
          ...task,
          preferredProfileId: "",
          requirePreferred: false,
          profileRequests: undefined,
          thinkingOptionId: "",
        },
        profiles,
        pool,
        this.store.counts(),
        unavailable,
        "coordinator",
        this.store.recentCounts(),
        this.store.usageLevel(),
      )?.profile ?? null
    );
  }
  /** The task facts a delegate reads: its title, stop, head, brief and latest review. Bounded. */
  decisionContext(task: Task): string[] {
    const clip = (text: string | null | undefined, max: number) =>
      (text ?? "").trim().replace(/\s+/g, " ").slice(0, max) || "none";
    const review = task.resolution.review;
    return [
      `Task: ${task.title} (${task.id})`,
      `Stop: ${task.resolution.stop?.reason ?? "none"} — ${clip(task.resolution.stop?.detail, 600)}`,
      `PR head: ${task.prHead ?? "none"}`,
      `Brief: ${clip(currentBrief(task)?.text, 3000)}`,
      `Latest review at ${review?.head ?? "none"}: source ${review?.sourceApproved ? "approved" : "not approved"}; awaiting proofs: ${awaitingProofTexts(review?.awaitingProofs ?? []).join("; ") || "none"}`,
      `Review: ${clip(review?.reviewText ?? review?.summary, 2000)}`,
    ];
  }
}
