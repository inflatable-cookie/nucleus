import { randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA, EVENT_SCHEMA_V2, EVENT_SCHEMA_V3, RESULT_SCHEMA,
  hookEventSchema, hookEventV2Schema, hookEventV3Schema, anyHookEventSchema, hookRecordSchema,
  type AnyHookEvent, type HookEventName, type HookRecord, type HookResult, type NormalizedHookDefinition,
} from "../../shared/hooks";
import type { Task } from "../../shared/contracts";
import { type Store, digest, now } from "../store/store";
import { pinProgram, type ManifestDiscovery } from "./hook-manifest";
import {
  hookRecordTarget, type HookContext, type HookEmissionResult,
} from "./hook-context";

/**
 * The durable record of one hook occurrence: the immutable delivered event, the
 * intent written before any external effect, and every transition after it.
 *
 * One owner for occurrence identity and record state. Callers decide what to run;
 * this module only states what has been recorded. A settled occurrence is reused
 * for the same target, an open one is resumed, and a new occurrence identity is
 * minted only after a terminal one.
 */
export interface HookOccurrenceContext {
  store: Store;
  isolationPath: (task: Task, eventId: string) => Promise<string>;
}

export class HookOccurrences {
  constructor(private readonly context: HookOccurrenceContext) {}
  private get store() { return this.context.store; }
  private get isolationPath() { return this.context.isolationPath; }

  /** Build the closed event payload. Event content is data; it never reaches argv or the shell. */
  buildEvent(task: Task, hook: NormalizedHookDefinition, eventId: string, attempt: number, context: HookContext, root = task.repoPath): AnyHookEvent {
    const delivery = context.delivery ?? {};
    if (!context.baseCommit) throw new Error("Hook event requires a base commit");
    const shared = {
      eventId, hookId: hook.id, event: context.event, occurredAt: now(), attempt,
      repository: { root, baseBranch: task.baseBranch, baseCommit: context.baseCommit },
      task: { id: task.id, title: task.title, phase: task.phase, instruction: context.instruction === undefined ? task.instruction ?? null : context.instruction },
      delivery: {
        prUrl: delivery.prUrl ?? null, prNumber: delivery.prNumber ?? null, head: delivery.head ?? null,
        review: delivery.review ?? null, mergeCommit: delivery.mergeCommit ?? null,
        integrationCommit: delivery.integrationCommit ?? null, summary: (delivery.summary ?? context.summary ?? "").slice(0, 4000),
      },
    };
    // Integration-base events keep the frozen v1 payload; a reviewed-head
    // occurrence emits the additive v2 payload with `repository.target`; a
    // prospective-merge occurrence emits v3 with its pinned candidate identity.
    if (hook.target === "reviewed_head") return hookEventV2Schema.parse({ schema: EVENT_SCHEMA_V2, ...shared, repository: { ...shared.repository, target: "reviewed_head" } });
    if (hook.target === "prospective_merge") {
      const candidate = context.candidate;
      if (!candidate) throw new Error("A prospective-merge event requires the pinned candidate identity");
      if (candidate.integrationBase !== context.baseCommit) throw new Error("A prospective-merge candidate must be built from the pinned integration base");
      const { path: _path, ...identity } = candidate;
      return hookEventV3Schema.parse({ schema: EVENT_SCHEMA_V3, ...shared, repository: { ...shared.repository, target: "prospective_merge", mergeCandidate: identity } });
    }
    return hookEventSchema.parse({ schema: EVENT_SCHEMA, ...shared });
  }

  /** Persist durable event intent before any external effect. Reuse an open record; new ids only after a terminal one. */
  async intent(task: Task, hook: NormalizedHookDefinition, discovery: ManifestDiscovery, context: HookContext): Promise<HookRecord> {
    const hookProgram = hook.program ?? { kind: "repository" as const, executable: (hook as unknown as { executable: string }).executable, argv: (hook as unknown as { argv: string[] }).argv };
    const existing = this.store.hookEvents(task.id).filter(record => record.hookId === hook.id && record.event === context.event);
    /**
     * True when a stored occurrence answers for the same exact pre-merge target.
     * A reviewed head is answered once per exact head; a prospective-merge
     * occurrence is answered once per exact candidate identity, so a moved
     * integration base always mints a fresh candidate instead of reusing an
     * unrelated result.
     */
    const samePreMergeTarget = (record: HookRecord): boolean => {
      if (record.manifest.digest !== discovery.pin.digest) return false;
      if (hookRecordTarget(record) !== hook.target) return false;
      if (hook.target === "prospective_merge") {
        const candidate = context.candidate;
        return Boolean(candidate)
          && record.mergeCandidate?.commit === candidate!.commit
          && record.mergeCandidate?.tree === candidate!.tree
          && record.mergeCandidate?.integrationBase === candidate!.integrationBase;
      }
      return record.baseCommit === context.baseCommit;
    };
    // Closeout happens once per task: a terminal success is reused rather than
    // re-emitted, so a restart or a successful retry keeps the same occurrence
    // identity instead of executing the repository hook a second time.
    if (context.event === "task.closeout") {
      const settled = existing.find(record => record.state === "result" || record.state === "published");
      if (settled) return settled;
    }
    // A pre-merge target owns at most one settled occurrence per manifest pin: an
    // unchanged target reuses its result, while a changed one mints a fresh
    // occurrence. A pre-archive occurrence is answered once per retained
    // worktree head, so an unchanged worktree is not gated twice while a
    // changed one mints a fresh occurrence.
    const sameRetentionTarget = (record: HookRecord): boolean =>
      record.manifest.digest === discovery.pin.digest
      && record.baseCommit === context.baseCommit
      && (record.workspace?.path ?? null) === (context.worktree ?? null);
    if (context.event === "task.pre_merge") {
      const settled = existing.find(record => record.state === "result" && samePreMergeTarget(record));
      if (settled) return settled;
    }
    if (context.event === "task.pre_archive") {
      const settled = existing.find(record => record.state === "result" && sameRetentionTarget(record));
      if (settled) return settled;
    }
    // The finished-task runtime stop is delivered at most once per task. A
    // settled result or an advisory failure is reused, so a restart or an
    // ordinary pass never runs the repository's stop a second time;
    // `retry_effect` clears the occurrence back to intent and re-runs the pinned
    // program. An uncertain attempt is re-emitted through the open-record path
    // below and never retried automatically.
    if (context.event === "task.finished") {
      const settled = existing.at(-1);
      if (settled) return settled;
    }
    // A held or uncertain event is resumed, never silently re-emitted. Only a
    // proven-success or advisory outcome may produce the next occurrence. A
    // pinned target is per occurrence: a held refusal at an older target never
    // answers for a changed one.
    const open = existing.find(record => !["result", "published", "failed"].includes(record.state)
      && (context.event !== "task.pre_merge" || samePreMergeTarget(record))
      && (context.event !== "task.pre_archive" || sameRetentionTarget(record)));
    if (open) return open;
    const occurrence = existing.length + 1;
    const eventId = digest(`${task.id}\n${hook.id}\n${context.event}\n${occurrence}`).slice(0, 48);
    const program = await pinProgram(task.repoPath, discovery.pin.commit, hookProgram);
    const executable = program.kind === "repository" ? program.executable : null;
    if (hookProgram.kind === "repository" && hook.allowedPaths.some(entry => entry.endsWith("/") ? hookProgram.executable.startsWith(entry) : entry === hookProgram.executable)) throw new Error(`allowedPaths may not name the hook executable: ${hookProgram.executable}`);
    const workspacePath = hook.mode === "integration_write" ? await this.isolationPath(task, eventId)
      : hook.target === "prospective_merge" ? context.candidate?.path ?? null
      : context.event === "task.pre_archive" ? context.worktree ?? null
      : context.event === "task.finished" ? context.worktree ?? null : null;
    // A reviewed-head gate always runs in the retained Queue task workspace so
    // it observes the worker's exact pushed head rather than the integration base.
    if (hook.target === "reviewed_head" && !task.directory) throw new Error("Reviewed-head hook requires the retained task workspace directory");
    // A prospective-merge gate runs only in the Queue-owned disposable candidate
    // checkout, never in the worker branch or the canonical integration checkout.
    if (hook.target === "prospective_merge" && !workspacePath) throw new Error("Prospective-merge hook requires the Queue-owned candidate checkout");
    // The retention gate runs in the retained task worktree it must observe
    // immediately before Queue archives it, never in the canonical checkout.
    if (context.event === "task.pre_archive" && !workspacePath) throw new Error("Pre-archive hook requires the retained task worktree path");
    // The finished-task stop runs in the retained worktree whose dev stack it
    // must stop, never in the canonical integration checkout.
    if (context.event === "task.finished" && !workspacePath) throw new Error("Finished-task hook requires the retained task worktree path");
    const executionRoot = hook.target === "reviewed_head" ? task.directory! : hook.target === "prospective_merge" ? workspacePath! : workspacePath ?? task.repoPath;
    const event = this.buildEvent(task, hook, eventId, 1, context, executionRoot);
    const record = hookRecordSchema.parse({
      id: randomUUID(), taskId: task.id, hookId: hook.id, event: context.event, eventId, occurrence,
      mode: hook.mode, delivery: hook.delivery, state: program.kind === "unavailable_tool" ? hook.delivery === "required" ? "blocked" : "failed" : "intent",
      manifest: discovery.pin, executable, program, instruction: event.task.instruction,
      baseBranch: task.baseBranch, baseCommit: context.baseCommit, attempt: 0,
      argv: hookProgram.argv, timeoutMs: hook.timeoutMs, maxOutputBytes: hook.maxOutputBytes,
      allowedPaths: hook.allowedPaths, commitSubject: hook.commitSubject,
      eventDigest: digest(JSON.stringify(event)), eventPayload: event,
      target: hook.target,
      mergeCandidate: hook.target === "prospective_merge" && context.candidate
        ? { integrationBase: context.candidate.integrationBase, reviewedHead: context.candidate.reviewedHead, commit: context.candidate.commit, tree: context.candidate.tree }
        : null,
      workspace: workspacePath ? { path: workspacePath, head: hook.target === "prospective_merge" ? context.candidate!.commit : context.baseCommit } : null,
      result: null, commit: null, remote: null,
      summary: program.kind === "unavailable_tool" ? program.error : "", error: program.kind === "unavailable_tool" ? program.error : "", createdAt: now(), updatedAt: now(), reconciledAt: null,
    });
    this.store.putHookEvent(record);
    this.store.event(task.id, program.kind === "unavailable_tool" ? `hook_${record.state}` : "hook_intent", `${hook.id} ${context.event} ${eventId}${program.kind === "unavailable_tool" ? `: ${program.error}` : ""}`);
    return record;
  }

  save(record: HookRecord, changes: Partial<HookRecord>): HookRecord {
    const next = hookRecordSchema.parse({ ...record, ...changes, updatedAt: now() });
    this.store.putHookEvent(next);
    return next;
  }

  /** The immutable occurrence payload with only the confirmed attempt advancing and the actual execution root. */
  deliveryEvent(record: HookRecord, root: string): AnyHookEvent {
    if (!record.eventPayload) throw new Error("Hook event payload is unavailable; reconcile the record before retrying");
    return anyHookEventSchema.parse({ ...record.eventPayload, attempt: record.attempt + 1, repository: { ...record.eventPayload.repository, root } });
  }

  settle(record: HookRecord, result: HookResult, extra: Partial<HookRecord> = {}): HookRecord {
    const outcome = result.outcome;
    const state: HookRecord["state"] = extra.state ?? (outcome === "ok" ? "result" : record.delivery === "required" ? "blocked" : "failed");
    const next = this.save(record, { ...extra, state, result, summary: result.summary, commit: extra.commit ?? record.commit, reconciledAt: extra.reconciledAt ?? record.reconciledAt });
    this.store.event(record.taskId, `hook_${state}`, `${record.hookId} ${record.event} ${record.eventId}: ${result.summary.slice(0, 500)}`);
    return next;
  }

  fail(record: HookRecord, error: string): HookRecord {
    const state: HookRecord["state"] = record.delivery === "required" ? "blocked" : "failed";
    const next = this.save(record, { state, error, summary: error.slice(0, 4000), processId: null });
    this.store.event(record.taskId, `hook_${state}`, `${record.hookId} ${record.event} ${record.eventId}: ${error.slice(0, 500)}`);
    return next;
  }

  uncertain(record: HookRecord, error: string): HookRecord {
    const next = this.save(record, { state: "uncertain", error, summary: error.slice(0, 4000), processId: null, reconciledAt: now() });
    this.store.event(record.taskId, "hook_uncertain", `${record.hookId} ${record.event} ${record.eventId}: ${error.slice(0, 500)}`);
    return next;
  }

  result(record: HookRecord): HookEmissionResult {
    return { hold: record.state === "blocked" || record.state === "uncertain" || (record.state === "failed" && record.delivery === "required"), attention: record.state === "uncertain" || record.state === "blocked" || (record.state === "failed" && record.delivery === "required"), records: [record] };
  }

  /** True when every occurrence of one event is a terminal success for its hook. */
  emissionSettled(taskId: string, event: HookEventName): boolean {
    const records = this.store.hookEvents(taskId).filter(record => record.event === event);
    if (!records.length) return false;
    const latest = new Map<string, HookRecord>();
    for (const record of records) {
      const current = latest.get(record.hookId);
      if (!current || record.occurrence > current.occurrence) latest.set(record.hookId, record);
    }
    return [...latest.values()].every(record => ["result", "published"].includes(record.state) || record.state === "failed" && record.delivery === "advisory");
  }
}

export function okResult(record: HookRecord): HookResult {
  return { schema: RESULT_SCHEMA, eventId: record.eventId, outcome: "ok", summary: record.summary || "Reconciled hook publication", metadata: {}, changedPaths: record.result?.changedPaths ?? [], commitSubjectSuffix: null };
}
