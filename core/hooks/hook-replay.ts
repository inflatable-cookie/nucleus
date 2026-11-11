import { type HookEmissionResult, type HookContext } from "./hook-context";
import { instructionForCommit, discoverManifest, pinExecutable, type ManifestDiscovery } from "./hook-manifest";
import { gitText, isolatedRepositoryIsCleanAt } from "../git/git-snapshot";
import { existsSync } from "node:fs";

import { AUTOMATIC_REPLAY_LIMIT, AUTOMATIC_REPLAY_RETRY_MS, hookReplayLineageSchema, hookEventSupportsAutomaticReplay, type NormalizedHookDefinition, type HookEventName, type HookRecord } from "../../shared/hooks";
import { isDispositionActive, type Task } from "../../shared/contracts";
import { type Store, now } from "../store/store";
import { gitRaw } from "../git/git-command";
import { HookObservationMap, type HeldAutomaticReplay, type AutomaticReplayAttempt } from "./hook-context";
/** Task-history kinds for automatic exact-identity base-advance replay. */
const AUTOMATIC_REPLAY_INTENT_KIND = "hook_automatic_replay_intent";
const AUTOMATIC_REPLAY_KIND = "hook_automatic_replay";
export const READ_ONLY_BASE_ADVANCED_KIND = "hook_read_only_base_advanced";
/**
 * The one closed operational refusal that makes an integration-base occurrence
 * operationally stale rather than semantically refused: the write could not
 * start because the pinned base was no longer the clean synchronized head.
 */
export const STALE_INTEGRATION_BASE_PROOF = "Integration write requires a clean synchronized base:";
/**
 * Every refusal that means an occurrence's pinned integration base is *stale* rather than wrong.
 *
 * verifyCleanSynchronizedBase refuses on three conditions - the checkout is not clean and
 * synchronized, its HEAD is not the event's base, or its base is behind origin. The first two and
 * the third are the same operational fact from different angles: the base the occurrence pinned has
 * been overtaken by later merges. Recognising only the first left a closeout holding on "Integration
 * HEAD moved from the event base" unreplayable and unrenewable while an active wave moved main under
 * it, so both retry_effect and discard retry_effect returned it to the same hold.
 */
const STALE_INTEGRATION_BASE_REFUSALS = [STALE_INTEGRATION_BASE_PROOF,
  "Integration HEAD moved from the event base", "Local integration base differs from origin"] as const;
/** True when a held hook's recorded error is a stale-base refusal. */
export const isStaleIntegrationBaseRefusal = (error: unknown): boolean => {
  const text = String(error ?? "");
  return STALE_INTEGRATION_BASE_REFUSALS.some(refusal => text.includes(refusal));
};

interface HookReplayContext {
  store: Pick<Store, "event" | "hookEvent" | "hookEvents" | "run" | "task">;
  save: (record: HookRecord, changes: Partial<HookRecord>) => HookRecord;
  matchingCommits: (task: Task, record: HookRecord) => Promise<string[]>;
  isolationPath: (task: Task, eventId: string) => Promise<string>;
  verifyCleanSynchronizedBase: (root: string, baseBranch: string, baseCommit: string) => Promise<void>;
  remoteCarries: (task: Task, record: HookRecord) => Promise<boolean>;
  remoteCarriesCommit: (task: Task, record: HookRecord, commit: string) => Promise<boolean>;
  removeIsolatedCheckout: (task: Task, path: string, force: boolean) => Promise<void>;
  runHook: (task: Task, hook: NormalizedHookDefinition, discovery: ManifestDiscovery, context: HookContext) => Promise<HookEmissionResult>;
  emit: (event: HookEventName, task: Task, context: HookContext, accept?: (hook: NormalizedHookDefinition) => boolean) => Promise<HookEmissionResult>;
}

export class HookReplay {
  constructor(private readonly context: HookReplayContext) {}
  private get store() { return this.context.store; }
  private get save() { return this.context.save; }
  private get matchingCommits() { return this.context.matchingCommits; }
  private get isolationPath() { return this.context.isolationPath; }
  private get verifyCleanSynchronizedBase() { return this.context.verifyCleanSynchronizedBase; }
  private get remoteCarries() { return this.context.remoteCarries; }
  private get remoteCarriesCommit() { return this.context.remoteCarriesCommit; }
  private get removeIsolatedCheckout() { return this.context.removeIsolatedCheckout; }
  private get runHook() { return this.context.runHook; }
  private get emit() { return this.context.emit; }

  /** Settle a read-only occurrence whose base advanced under it, so the next emission evaluates the new base. */
  supersedeForBaseAdvance(record: HookRecord, from: string, to: string): HookRecord {
    const summary = `Superseded: the integration base fast-forwarded from ${from} to published ${to} while the read-only hook ran`;
    const saved = this.save(record, { state: "failed", error: summary, summary, processId: null, reconciledAt: now(), baseAdvance: { from, to, at: now() } });
    this.store.event(record.taskId, READ_ONLY_BASE_ADVANCED_KIND, `${record.hookId} ${record.event} ${record.eventId}: ${from} → ${to}`);
    return saved;
  }

  /**
   * Operator retry of a pre-dispatch gate whose base advanced: a result pinned to
   * the old base cannot answer for the new one, so the old occurrence is settled
   * as superseded and a fresh gate runs at the current clean synchronized base.
   * Returns null when the base has not advanced by fast-forward, leaving the
   * ordinary retry proofs in charge.
   */
  async renewAdvancedPreDispatch(task: Task, record: HookRecord): Promise<HookEmissionResult | null> {
    if (record.event !== "task.pre_dispatch" || record.mode !== "read_only" || record.processId) return null;
    if (!record.baseAdvance && record.state !== "uncertain") return null;
    const latest = this.store.hookEvents(task.id).findLast(candidate => candidate.hookId === record.hookId && candidate.event === record.event);
    if (latest?.id !== record.id) return null;
    let head: string;
    try {
      head = await gitText(task.repoPath, "rev-parse", "HEAD");
      if (head === record.baseCommit) return null;
      if ((await gitRaw(task.repoPath, ["merge-base", "--is-ancestor", record.baseCommit, head])).code !== 0) return null;
      await this.verifyCleanSynchronizedBase(task.repoPath, record.baseBranch, head);
    } catch { return null; }
    if (!record.baseAdvance) this.supersedeForBaseAdvance(record, record.baseCommit, head);
    return this.emit("task.pre_dispatch", this.store.task(task.id), { event: "task.pre_dispatch", baseCommit: head, summary: task.reason }, hook => hook.id === record.hookId);
  }

  /**
   * The durable half of the automatic replay proof: the task still owns a
   * required integration-base occurrence whose only recorded failure is the
   * operational stale-base refusal, with no semantic refusal, attempt result,
   * commit, push or remote publication. Returns the automatic ordinal that a
   * fresh occurrence would carry, or null when the two-replay budget is spent.
   */
  heldAutomaticReplay(task: Task): HeldAutomaticReplay | null {
    const records = this.store.hookEvents(task.id).filter(record => hookEventSupportsAutomaticReplay(record.event)
      && record.mode === "integration_write" && record.delivery === "required");
    const seen = new Set<string>();
    for (const record of [...records].reverse()) {
      const key = `${record.hookId}:${record.event}`;
      // Only the latest occurrence of one bound event can be the current hold.
      if (seen.has(key)) continue;
      seen.add(key);
      if (record.state !== "blocked") continue;
      if (record.result !== null || record.commit !== null || record.remote !== null) continue;
      if (!isStaleIntegrationBaseRefusal(record.error)) continue;
      if (!this.heldEventStillApplies(task, record)) continue;
      return { record, ordinal: this.nextAutomaticReplayOrdinal(task.id, record) };
    }
    return null;
  }

  /** True when one required integration-base occurrence can still be re-evaluated automatically. */
  automaticReplayAvailable(task: Task): boolean {
    const held = this.heldAutomaticReplay(task);
    return Boolean(held && held.ordinal !== null);
  }

  /**
   * True when the automatic proof should run again for this held occurrence. The
   * current attempt base is remembered for a short interval, so one failed proof
   * is not repeated on every pass at an unchanged base while a base that
   * actually moved reopens the automatic path immediately.
   */
  async automaticReplayAttemptDue(task: Task): Promise<boolean> {
    const held = this.heldAutomaticReplay(task);
    if (!held || held.ordinal === null) return false;
    const attempt = this.automaticReplayAttempts.get(held.record.id);
    if (!attempt) return true;
    const base = await this.automaticReplayBase(task, held.record);
    return base === null || base !== attempt.base || Date.now() - attempt.at >= AUTOMATIC_REPLAY_RETRY_MS;
  }

  /** The integration base an automatic replay attempt would pin for one occurrence. */
  private async automaticReplayBase(task: Task, record: HookRecord): Promise<string | null> {
    if (record.event === "task.closeout") return gitText(task.repoPath, "rev-parse", "HEAD").catch(() => null);
    return gitText(task.repoPath, "rev-parse", `refs/heads/${record.baseBranch}`).catch(() => null);
  }

  /** Bases already attempted for one held occurrence, so one failed proof is not repeated at once. */
  private readonly automaticReplayAttempts = new HookObservationMap<{ base: string; at: number }>();

  /** The held event must still be the transition the task actually owes. */
  private heldEventStillApplies(task: Task, record: HookRecord): boolean {
    if (task.disposition?.status === "complete") return false;
    if (record.event === "task.cancelled")
      return isDispositionActive(task) && ["cancel", "supersede"].includes(task.disposition?.kind ?? "");
    if (record.event === "task.closeout") return task.phase === "closing";
    if (record.event === "task.blocked") {
      const run = task.resolution.currentRunId ? this.store.run(task.resolution.currentRunId) : null;
      if (run?.completion && ["blocked", "error"].includes(run.completion.status)) return true;
      // The initial worker may report the blocked result instead of a resolution run.
      return Boolean(task.completion && ["blocked", "error"].includes(task.completion.status));
    }
    return false;
  }

  /**
   * The ordinal of the next automatic base-advance replay for one logical
   * event, or null when the two-replay budget is spent. A persisted intent
   * whose occurrence was not minted yet keeps its ordinal, so restart
   * reconciliation re-mints the same occurrence instead of spending a second
   * advance.
   */
  private nextAutomaticReplayOrdinal(taskId: string, record: HookRecord): number | null {
    const same = this.store.hookEvents(taskId).filter(candidate => candidate.hookId === record.hookId && candidate.event === record.event);
    const minted = new Set(same.filter(candidate => candidate.replay).map(candidate => candidate.replay!.ordinal));
    const pending = same.map(candidate => candidate.replayIntent).filter((intent): intent is NonNullable<typeof intent> => Boolean(intent))
      .sort((a, b) => a.ordinal - b.ordinal).find(intent => !minted.has(intent.ordinal));
    const used = Math.max(0, ...same.map(candidate => candidate.replay?.ordinal ?? candidate.replayIntent?.ordinal ?? 0));
    const ordinal = pending ? pending.ordinal : used + 1;
    return ordinal <= AUTOMATIC_REPLAY_LIMIT ? ordinal : null;
  }

  /**
   * One closed exact-identity and absence-of-effect proof for an automatic
   * base-advance replay. Every fact must be exact: unchanged occurrence,
   * repository, base branch, task disposition and event; unchanged instruction,
   * hook, program and normalized manifest semantics; no commit, push or remote
   * publication and no ambiguous process or delivery effect; a provably
   * unchanged or safely disposable Queue-owned checkout; and a clean,
   * synchronized, fast-forwarded canonical integration base.
   */
  private async automaticReplayProof(
    task: Task,
    record: HookRecord,
    hook: NormalizedHookDefinition,
    baseCommit: string,
    context: HookContext,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const refuse = (reason: string) => ({ ok: false as const, reason });
    try {
      const payload = record.eventPayload;
      if (!payload) return refuse("the immutable occurrence payload is unavailable");
      if (record.hookId !== hook.id || payload.hookId !== record.hookId || payload.event !== record.event || payload.eventId !== record.eventId)
        return refuse("the occurrence identity changed");
      if (record.baseBranch !== task.baseBranch || payload.repository.baseBranch !== record.baseBranch)
        return refuse("the integration base branch changed");
      const delivery = context.delivery ?? {};
      if (delivery.prNumber != null && payload.delivery.prNumber != null && delivery.prNumber !== payload.delivery.prNumber)
        return refuse("the task's pull request changed");
      if (delivery.head != null && payload.delivery.head != null && delivery.head !== payload.delivery.head)
        return refuse("the exact reviewed head changed");
      if (baseCommit === record.baseCommit) return refuse("the integration base has not advanced");
      if ((await this.matchingCommits(task, record)).length) return refuse("a commit carrying this hook event already exists");
      if ((await gitRaw(task.repoPath, ["merge-base", "--is-ancestor", record.baseCommit, baseCommit])).code !== 0)
        return refuse("the integration base did not advance by fast-forward");
      const isolation = await this.isolationPath(task, record.eventId);
      if (payload.repository.root !== isolation)
        return refuse("the recorded occurrence belongs to another repository or event");
      await this.verifyCleanSynchronizedBase(task.repoPath, record.baseBranch, baseCommit);
      const semantics = await this.sameHookSemantics(task, record, hook, baseCommit);
      if (semantics) return refuse(semantics);
      const instruction = await this.sameInstruction(task, record, baseCommit);
      if (instruction) return refuse(instruction);
      const path = record.workspace?.path;
      if (path && existsSync(path) && !await isolatedRepositoryIsCleanAt(path, record.baseCommit, record.baseBranch))
        return refuse("the previous Queue-owned checkout is not provably unchanged");
      return { ok: true };
    } catch (error) { return refuse(error instanceof Error ? error.message : String(error)); }
  }

  /** Compare the currently bound hook with the pinned semantics of the stale occurrence. */
  private async sameHookSemantics(task: Task, record: HookRecord, hook: NormalizedHookDefinition, baseCommit: string): Promise<string | null> {
    if (!hook.events.includes(record.event)) return "the event is no longer bound";
    if (hook.target !== "integration_base") return "the hook target changed";
    if (hook.mode !== record.mode || hook.delivery !== record.delivery) return "the hook mode or delivery changed";
    if (JSON.stringify(hook.allowedPaths) !== JSON.stringify(record.allowedPaths)) return "the declared allowed paths changed";
    if (JSON.stringify(hook.commitSubject) !== JSON.stringify(record.commitSubject)) return "the commit subject changed";
    if (hook.timeoutMs !== record.timeoutMs || hook.maxOutputBytes !== record.maxOutputBytes) return "the hook output bounds changed";
    if (record.program.kind === "repository") {
      if (hook.program.kind !== "repository") return "the hook program kind changed";
      if (hook.program.executable !== record.program.executable.path) return "the hook executable path changed";
      if (JSON.stringify(hook.program.argv) !== JSON.stringify(record.program.argv)) return "the hook arguments changed";
      const executable = await pinExecutable(task.repoPath, baseCommit, hook.program.executable);
      if (executable.digest !== record.program.executable.digest) return "the hook executable changed";
      return null;
    }
    if (record.program.kind === "tool" && hook.program.kind === "tool" && hook.program.name === record.program.name && JSON.stringify(hook.program.argv) === JSON.stringify(record.program.argv)) return null;
    return "the recorded hook program is unavailable or changed";
  }

  /** The committed instruction artifact must keep its path and digest at the new base. */
  private async sameInstruction(task: Task, record: HookRecord, baseCommit: string): Promise<string | null> {
    const submitted = task.instruction ?? null;
    if ((record.instruction?.path ?? null) !== (submitted?.path ?? null)) return "the submitted instruction path changed";
    if ((record.instruction?.digest ?? null) !== (submitted?.digest ?? null)) return "the submitted instruction changed";
    if (!record.instruction) return null;
    const atBase = await instructionForCommit(task.repoPath, baseCommit, record.instruction.path, record.instruction.mediaType);
    if (atBase.digest !== record.instruction.digest) return "the committed instruction changed at the current integration base";
    return null;
  }

  /**
   * Re-evaluate one operationally stale required integration-base occurrence.
   * `applied` is returned only after the durable intent persisted and the fresh
   * occurrence was evaluated normally; a successful replay never asserts hook
   * success. `not-applicable` keeps the caller's existing repaired-occurrence
   * and recovery behaviour, and `exhausted` hands the movement to bounded
   * recovery instead of minting a third automatic occurrence.
   */
  async automaticReplay(
    task: Task,
    hook: NormalizedHookDefinition,
    discovery: ManifestDiscovery,
    baseCommit: string,
    context: HookContext,
  ): Promise<AutomaticReplayAttempt> {
    const held = this.heldAutomaticReplay(this.store.task(task.id));
    if (!held || held.record.hookId !== hook.id) return { status: "not-applicable" };
    if (held.ordinal === null) return { status: "exhausted" };
    // Integration writes stay serialized per repository: re-prove and mint
    // inside one per-repository section so a concurrent task cannot spend the
    // same advance or mint a duplicate occurrence.
    return this.withRepositoryLock(task.repoPath, async () => {
      const latest = this.store.task(task.id);
      const current = this.heldAutomaticReplay(latest);
      if (!current || current.record.id !== held.record.id || current.ordinal === null || current.record.hookId !== hook.id)
        return { status: "not-applicable" as const };
      // The attempt is remembered before the proof, so a refusal at this base
      // cannot re-run on every pass while the base is unchanged.
      this.automaticReplayAttempts.set(current.record.id, { base: baseCommit, at: Date.now() });
      const proof = await this.automaticReplayProof(latest, current.record, hook, baseCommit, context);
      if (!proof.ok) return { status: "not-applicable" as const };
      const record = current.record;
      // Durable replay intent and lineage precede the replacement occurrence.
      this.save(record, { replayIntent: { automatic: true, ordinal: current.ordinal, baseCommit, at: now() } });
      this.store.event(task.id, AUTOMATIC_REPLAY_INTENT_KIND, `${record.hookId} ${record.event} ${record.eventId}: automatic replay ${current.ordinal}/${AUTOMATIC_REPLAY_LIMIT} at ${baseCommit}`);
      const instruction = record.instruction
        ? await instructionForCommit(task.repoPath, baseCommit, record.instruction.path, record.instruction.mediaType)
        : record.instruction;
      const outcome = await this.renewOccurrence(latest, record, hook, discovery, { ...context, event: record.event, baseCommit, baseBranch: record.baseBranch, instruction }, `the integration base advanced from ${record.baseCommit} to ${baseCommit}`);
      const fresh = outcome.records.at(-1);
      if (!fresh || fresh.eventId === record.eventId) return { status: "not-applicable" as const };
      const lineage = hookReplayLineageSchema.parse({ automatic: true, ordinal: current.ordinal, baseCommit,
        fromEventId: record.eventId, fromOccurrence: record.occurrence, at: now() });
      const replayed = this.save(this.store.hookEvent(fresh.id)!, { replay: lineage });
      this.automaticReplayAttempts.delete(record.id);
      this.store.event(task.id, AUTOMATIC_REPLAY_KIND, `${record.hookId} ${record.event} ${record.eventId} → ${replayed.eventId}: automatic replay ${current.ordinal}/${AUTOMATIC_REPLAY_LIMIT} at ${baseCommit}`);
      return { status: "applied" as const, outcome: { ...outcome, records: outcome.records.map(candidate => candidate.id === replayed.id ? replayed : candidate) } };
    });
  }

  /** One in-process section per repository for automatic replay proof and intent. */
  private readonly repositoryLocks = new Map<string, Promise<unknown>>();

  private async withRepositoryLock<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
    const prior = this.repositoryLocks.get(repoPath) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = prior.then(() => gate, () => gate);
    this.repositoryLocks.set(repoPath, tail);
    await prior.catch(() => { /* a failed predecessor never blocks the next section */ });
    try { return await work(); }
    finally {
      release();
      if (this.repositoryLocks.get(repoPath) === tail) this.repositoryLocks.delete(repoPath);
    }
  }

  /** One publication proof and supersession path for a replacement occurrence. */
  private async renewOccurrence(task: Task, record: HookRecord, hook: NormalizedHookDefinition,
    discovery: ManifestDiscovery, context: HookContext, repair: string): Promise<HookEmissionResult> {
    if (record.commit && await this.remoteCarries(task, record))
      throw new Error("A stale hook crossed the publication boundary and cannot be replaced");
    for (const sha of await this.matchingCommits(task, record)) {
      if (await this.remoteCarriesCommit(task, record, sha))
        throw new Error("A commit carrying the stale hook event is already published");
    }
    await this.verifyCleanSynchronizedBase(task.repoPath, record.baseBranch, context.baseCommit!);
    const path = record.workspace?.path;
    if (path && existsSync(path)) {
      if (!await isolatedRepositoryIsCleanAt(path, record.baseCommit, record.baseBranch))
        throw new Error("The stale hook checkout is not clean at its recorded base; an explicit discardUnpublishedCheckout retry requires proof of unpublished hook-owned content");
      await this.removeIsolatedCheckout(task, path, true);
    }
    const summary = `Superseded before publication after ${repair}`;
    this.save(this.store.hookEvent(record.id)!, { state: "failed", error: summary, summary, workspace: null, processId: null, reconciledAt: now() });
    this.store.event(task.id, "hook_occurrence_superseded", `${record.hookId} ${record.event} ${record.eventId}: ${repair}`);
    return this.runHook(task, hook, discovery, context);
  }

  async rollRepairedCloseoutOccurrence(task: Task, record: HookRecord, operator = false): Promise<HookEmissionResult | null> {
    if (record.event !== "task.closeout" || record.mode !== "integration_write" || record.state !== "blocked") return null;
    // Automatic base races keep their exact-identity proof and retry budget.
    // An explicit operator retry may renew a repaired, unpublished occurrence,
    // including one whose earlier result prevents automatic replay. The clean
    // base, checkout and absence-of-publication proofs below still apply.
    // A retry before synchronization may replace the visible error with base
    // staleness while retaining the original semantic result. That remains a
    // repaired closeout, not an eligible result-free automatic replay.
    if (!operator && record.result === null && record.error.includes(STALE_INTEGRATION_BASE_PROOF)) return null;
    const baseCommit = task.resolution.syncedCommit;
    if (!baseCommit) return null;
    const review = task.resolution.review?.summary ?? null;
    const baseChanged = baseCommit !== record.baseCommit;
    const reviewChanged = !!review && record.eventPayload?.delivery.review !== review;
    if (!baseChanged && !reviewChanged) return null;
    if (task.phase !== "closing") throw new Error("A stale closeout hook can only be replaced while the task is closing");
    const discovery = await discoverManifest(task.repoPath, baseCommit);
    const hook = discovery?.manifest.hooks.find(candidate => candidate.id === record.hookId && candidate.events.includes(record.event));
    if (!discovery || !hook) throw new Error("The closeout hook is no longer bound at the synchronized integration base");
    if (hook.mode !== "integration_write" || hook.delivery !== "required") throw new Error("The replacement closeout hook no longer owns the required integration write");
    const repair = baseChanged
      ? `the synchronized integration base advanced from ${record.baseCommit} to ${baseCommit}`
      : "durable accepted-review evidence was restored";
    const delivery = { ...record.eventPayload!.delivery, review, integrationCommit: baseCommit };
    const instruction = baseChanged && task.instruction
      ? await instructionForCommit(task.repoPath, baseCommit, task.instruction.path, task.instruction.mediaType)
      : record.instruction;
    return this.renewOccurrence(task, record, hook, discovery, { event: record.event, baseCommit, baseBranch: record.baseBranch, summary: task.reason, instruction, delivery }, repair);
  }

  /**
   * A cancellation publication may be overtaken by unrelated integration work
   * before its isolated checkout starts. Once Queue proves that the old
   * occurrence never crossed the commit boundary, retain it as failed audit
   * evidence and mint the disposition at the current synchronized base.
   */
  async rollRepairedCancellationOccurrence(
    task: Task,
    record: HookRecord,
    baseCommit: string,
    hook: NormalizedHookDefinition,
    discovery: ManifestDiscovery,
    context: HookContext,
  ): Promise<HookEmissionResult | null> {
    // `uncertain` as well as `blocked`: the checks below are the real proof that nothing was
    // published, and they are stronger than the state. An uncertain occurrence whose base
    // moved satisfied neither this renewal (state) nor the pre-commit proof (base), so it had
    // no route at all.
    if (record.event !== "task.cancelled" || record.mode !== "integration_write") return null;
    if (!["blocked", "uncertain"].includes(record.state)) return null;
    if (baseCommit === record.baseCommit) return null;
    if (hook.id !== record.hookId || !hook.events.includes("task.cancelled")) throw new Error("The cancellation hook identity changed at the current integration base");
    if (hook.mode !== "integration_write") throw new Error("The replacement cancellation hook no longer owns the integration write");
    const repair = `the integration base advanced from ${record.baseCommit} to ${baseCommit} before publication`;
    return this.renewOccurrence(task, record, hook, discovery, { ...context, event: "task.cancelled", baseCommit, baseBranch: record.baseBranch }, repair);
  }

  /**
   * A worker-blocked publication may be overtaken by unrelated integration
   * work before its isolated checkout starts. Preserve the original occurrence
   * as audit evidence and publish the same worker result at current main.
   */
  async rollRepairedBlockedOccurrence(
    task: Task,
    record: HookRecord,
    baseCommit: string,
  ): Promise<HookEmissionResult | null> {
    if (record.event !== "task.blocked" || record.mode !== "integration_write" || record.state !== "blocked") return null;
    const staleSchema=/^(?:control manifest|event) declares unsupported schema /.test(record.summary);
    const currentRun=task.resolution.currentRunId?this.store.run(task.resolution.currentRunId):null;
    const detachedBlockedDelivery=record.error.includes(STALE_INTEGRATION_BASE_PROOF)&&
      !Boolean(task.completion&&['blocked','error'].includes(task.completion.status))&&
      !Boolean(currentRun?.completion&&['blocked','error'].includes(currentRun.completion.status));
    if (!staleSchema&&!detachedBlockedDelivery) return null;
    if (baseCommit === record.baseCommit) return null;
    if (!record.eventPayload) throw new Error("A stale blocked hook requires its immutable delivery payload");
    const discovery = await discoverManifest(task.repoPath, baseCommit);
    const hook = discovery?.manifest.hooks.find(candidate => candidate.id === record.hookId && candidate.events.includes("task.blocked"));
    if (!discovery || !hook) throw new Error("The blocked hook is no longer bound at the synchronized integration base");
    if (hook.mode !== "integration_write" || hook.delivery !== "required") throw new Error("The replacement blocked hook no longer owns the required integration write");
    const repair = `the integration base advanced from ${record.baseCommit} to ${baseCommit} before publication`;
    const instruction = task.instruction
      ? await instructionForCommit(task.repoPath, baseCommit, task.instruction.path, task.instruction.mediaType)
      : record.instruction;
    const delivery = record.eventPayload.delivery;
    return this.renewOccurrence(task, record, hook, discovery, {
      event: "task.blocked",
      baseCommit,
      baseBranch: record.baseBranch,
      summary: delivery.summary,
      instruction,
      delivery,
    }, repair);
  }

}
