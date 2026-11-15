/**
 * Task 104: the durable QA request identity and its one atomic admission claim.
 *
 * A request is written before repository lookup or fetch, so a roll mid-admission
 * leaves a record the next writer settles instead of an unknown delivery. The
 * claim itself is one store transaction after the read-only fetch: a fetch never
 * writes, so two callers that fetched together still serialize at the claim and
 * the loser returns the winner's running row. Every refusal names the boundary it
 * stopped at (`QaAdmissionRefusal`), so a scheduler never reads the diagnostic
 * text to decide what happens next.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomicOwnedFile } from "../machine/owned-file.mjs";
import { digest, now, type Store } from "../store/store";
import {
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  projectQaRequestSchema,
  projectQaRunInputSchema,
  projectQaRunSchema,
  type ProjectQaRequest,
  type ProjectQaRun,
  type ProjectQaRunInput,
  type ProjectQaStage,
  type RepositorySettings,
} from "../../shared/contracts";
import { HostRunScheduler, classifyHostRun, selectorForArgv } from "../host-runs/host-run-scheduler";
import { qaFenceRefusal } from "./qa-fence";
import { projectQaEnvelopeMs, DEFAULT_PROJECT_QA_ARGV, DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES, DEFAULT_PROJECT_QA_TIMEOUT_MS } from "./project-qa-defaults";
import { QA_INTERRUPTED_PREPARATION_PREFIX } from "./project-qa-defaults";
import { refuseQaAdmission, qaAdmissionRefusalCode } from "./project-qa-refusals";
import { projectQaPlacement, type QaPlacementContext } from "./project-qa-placement";
import type { ProjectQaLaunch, ResolvedRepository } from "./project-qa-context";

const sleep = (ms: number) => new Promise<void>(resolvePromise => { setTimeout(resolvePromise, ms); });

export interface QaAdmissionContext extends QaPlacementContext {
  store: Store;
  hostRuns: Pick<HostRunScheduler, "authority">;
  options: QaPlacementContext["options"] & { ownerInstance?: string };
  /** The owner identity this runner writes on its requests: the writer lease when the runtime supplies it. */
  readonly ownerInstance: string;
  qaCallerIdentity(key: string, runId: string): string;
  resolveRepository(input: string, baseBranch: string): Promise<ResolvedRepository>;
  reconcile(key: string, requestedId?: string): Promise<void>;
  integrationHead(checkoutPath: string, baseBranch: string): Promise<string>;
  attachQueued(run: ProjectQaRun): void;
  get(input: { id: string } | { repository: string }): Promise<ProjectQaRun | null>;
  requestRun(input: ProjectQaRunInput, admissionGuard?: (proposed: ProjectQaRun, selected: ProjectQaRun) => void): Promise<ProjectQaRun>;
  admitRequest(input: ProjectQaRunInput, request: ProjectQaRequest, admissionGuard?: (proposed: ProjectQaRun, selected: ProjectQaRun) => void): Promise<ProjectQaRun>;
  submitToHostScheduler(run: ProjectQaRun, launch: ProjectQaLaunch): void;
  qaRepositoryRootPath(key: string): string;
}

/** #121: the ordered stages one admitted run executes; a single-argv setting is one "qa" stage. */
function qaStages(setting: RepositorySettings["qa"] | null | undefined): ProjectQaStage[] {
  return setting?.stages
    ? setting.stages.map(stage => ({ ...stage, maxOutputBytes: stage.maxOutputBytes ?? setting.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES }))
    : [{ name: "qa", argv: setting?.argv ?? [...DEFAULT_PROJECT_QA_ARGV],
        timeoutMs: setting?.timeoutMs ?? DEFAULT_PROJECT_QA_TIMEOUT_MS,
        maxOutputBytes: setting?.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES }];
}

export const projectQaAdmission = {
  /**
   * Settle requests a predecessor writer left preparing. The single-writer
   * lease (`processOwner`, taken only when the previous owner's process is
   * gone) proves a request owned by anyone other than the current lease holder
   * can no longer reach its admission claim on this store; the claim
   * transaction sets `admitted` together with the run, so a request still
   * `preparing` claimed no QA run and submitted no host run. Only runs while
   * this runner holds the lease; never touches its own preparations, admitted
   * or refused requests, or a record whose owner binding does not decode.
   */
  settleInterruptedPreparations(this: QaAdmissionContext): number {
    return this.store.transaction(() => {
      const lease = this.store.getMeta<{ owner?: unknown }>("processOwner");
      if (!lease || lease.owner !== this.ownerInstance || !this.options.ownerInstance) return 0;
      let settled = 0;
      for (const row of this.store.db.prepare(`SELECT key, value FROM meta WHERE key GLOB 'projectQaRequest:*'
        AND CASE WHEN json_valid(value) THEN json_extract(value,'$.state')='preparing' ELSE 0 END ORDER BY key`).all()) {
        let decoded: unknown;
        try { decoded = JSON.parse(String(row.value)); } catch { continue; }
        const parsed = projectQaRequestSchema.safeParse(decoded);
        if (!parsed.success || parsed.data.state !== "preparing" || parsed.data.ownerInstance === this.ownerInstance) continue;
        const request = parsed.data;
        this.store.setMeta(String(row.key), { ...request, state: "refused", settledAt: now(),
          refusalCode: "interrupted_preparation",
          diagnostic: `${QA_INTERRUPTED_PREPARATION_PREFIX}: its owner ${request.ownerInstance} (pid ${request.ownerPid}) is a predecessor of the current writer lease ${this.ownerInstance}, and it ended before an admission claim, so this request claimed no QA run and submitted no host run. Retry with a new request ID` });
        settled++;
      }
      return settled;
    });
  },

  /** One page of request and run records for the board's request-status read. */
  requestStatus(this: QaAdmissionContext, input: { requestId: string } | { repository: string; since: string; expectedHead: string }) {
    const requests = this.store.qaRequestRecords(input).map(record => projectQaRequestSchema.parse(record));
    const runs = "requestId" in input
      ? requests.flatMap(record => { const run = record.runId ? this.store.qaRun(record.runId) : null; return run ? [run] : []; })
      : this.store.qaHistoryForRequest(input);
    if (requests.length > 100 || runs.length > 100) throw new Error("QA request-status exceeds 100 records; narrow the time window or use requestId");
    return { ownerInstance: this.ownerInstance, ownerPid: process.pid, requests, runs };
  },

  /** Start a milestone QA run, or return the one already running, and optionally wait for it to settle. */
  async run(this: QaAdmissionContext, input: ProjectQaRunInput | { repository: string; baseBranch?: string; requestId?: string; expectedHead?: string; wait?: boolean }, admissionGuard?: (proposed: ProjectQaRun, selected: ProjectQaRun) => void): Promise<ProjectQaRun> {
    const { wait, ...request } = projectQaRunInputSchema.parse(input);
    const run = await this.requestRun(request, admissionGuard);
    if (!wait) return run;
    let current = run;
    while (current.state === "queued" || current.state === "running") {
      await sleep(250);
      const observed = await this.get({ id: run.id });
      if (!observed) throw new Error(`QA run ${run.id} disappeared while waiting; inspect project.qa.request-status`);
      current = observed;
    }
    let failuresLogPath: string | null = null;
    if (current.failuresLog) {
      const root = this.qaRepositoryRootPath(current.key);
      await mkdir(root, { recursive: true, mode: 0o700 });
      failuresLogPath = join(root, `${current.id}.failures.log`);
      writeAtomicOwnedFile(failuresLogPath, current.failuresLog);
    }
    return { ...current, failuresLogPath };
  },

  /** Record the request identity, then admit it; a refusal keeps the identity and its typed code. */
  async requestRun(this: QaAdmissionContext, input: ProjectQaRunInput, admissionGuard?: (proposed: ProjectQaRun, selected: ProjectQaRun) => void): Promise<ProjectQaRun> {
    const parsed = projectQaRunInputSchema.parse(input);
    const normalized = projectQaRunInputSchema.parse({ ...parsed, requestId: parsed.requestId ?? randomUUID() });
    const metaKey = `projectQaRequest:${normalized.requestId}`;
    const existing = this.store.transaction(() => {
      const previous = this.store.getMeta<ProjectQaRequest>(metaKey);
      if (!previous) this.store.setMeta(metaKey, projectQaRequestSchema.parse({ id: normalized.requestId, input: normalized,
        ownerInstance: this.ownerInstance, ownerPid: process.pid, receivedAt: now(), state: "preparing", runId: null, diagnostic: "" }));
      return previous;
    });
    if (existing) {
      const { wait: _wait, ...previousInput } = projectQaRunInputSchema.parse(existing.input);
      if (JSON.stringify(previousInput) !== JSON.stringify(normalized))
        refuseQaAdmission("request_conflict", "QA request ID is already bound to different input");
      if (existing.state === "admitted" && existing.runId) {
        const run = this.store.qaRun(existing.runId);
        if (!run) refuseQaAdmission("request_conflict", "QA request's admitted run is missing; inspect request-status, do not resubmit");
        return run;
      }
      refuseQaAdmission("request_conflict", `QA request ${existing.id} is ${existing.state}: ${existing.diagnostic || "preparation delivery unresolved; inspect project.qa.request-status"}`);
    }
    const request = this.store.getMeta<ProjectQaRequest>(metaKey)!;
    try { return await this.admitRequest(normalized, request, admissionGuard); }
    catch (error) {
      // Admission and its request link commit together. Never relabel an admitted
      // run as refused because scheduling or response delivery subsequently failed.
      if (this.store.getMeta<ProjectQaRequest>(metaKey)?.state === "preparing")
        this.store.setMeta(metaKey, { ...request, state: "refused", refusalCode: qaAdmissionRefusalCode(error),
          diagnostic: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  /** Fetch the integration head read-only, then claim the run, its request link and the fence check in one transaction. */
  async admitRequest(this: QaAdmissionContext, input: ProjectQaRunInput, request: ProjectQaRequest, admissionGuard?: (proposed: ProjectQaRun, selected: ProjectQaRun) => void): Promise<ProjectQaRun> {
    const baseBranch = input.baseBranch || "main";
    const resolved = await this.resolveRepository(input.repository, baseBranch);
    await this.reconcile(resolved.key);
    // Fetch the current integration head before claiming, so a fetch failure
    // refuses without storing a doomed run. Read-only: concurrent callers may
    // repeat it; the claim below stays atomic.
    const base = await this.integrationHead(resolved.checkoutPath, baseBranch);
    if (input.expectedHead && base !== input.expectedHead)
      refuseQaAdmission("expected_head_mismatch", `QA integration head differs from expected head: ${base}`);
    const settings = this.store.canonicalRepository(resolved.checkoutPath, resolved.origin);
    // The milestone command is the repository's `qa` setting, never `validation`: that one
    // also runs on every task's prospective merge (project-k planner, 2026-09-30).
    const qaSetting = settings?.qa ?? null;
    const stages = qaStages(qaSetting);
    const argv = stages[0].argv;
    // The whole run is admitted once. A staged setting's scheduler envelope must
    // cover the setup hook, every stage's own timeout and the teardown hook, so
    // setup or an earlier stage can never consume a later stage's
    // launch-relative window; each stage's timeout starts when that stage
    // launches. A single-argv setting keeps its record shape unchanged: one
    // stage, its configured timeout as the run timeout.
    const timeoutMs = qaSetting?.stages ? projectQaEnvelopeMs(stages) : stages[0].timeoutMs;
    const maxOutputBytes = qaSetting?.maxOutputBytes ?? DEFAULT_PROJECT_QA_MAX_OUTPUT_BYTES;
    const terminationGraceMs = qaSetting?.terminationGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS;
    const id = randomUUID();
    const placement = projectQaPlacement.qaPlacement(this);
    const allocation = placement ? join(placement.dataDir, "project-qa", digest(resolved.key).slice(0, 24), id) : null;
    let storageError: unknown = null;
    if (allocation) { try { placement!.admit(allocation); } catch (error) { storageError = error; } }
    const caller = this.qaCallerIdentity(resolved.key, id);
    const selector = selectorForArgv(argv, "qa");
    // #121: one parent admission covers the whole staged setting in any order,
    // so a later heavy stage is never admitted as a light-only parent. The
    // source names where the class the run actually took came from: a manifest
    // that declared only a lighter stage is not evidence that it selected a
    // heavier run (papercut 65c2883a).
    const classifications = stages.map(stage => {
      const stageSelector = selectorForArgv(stage.argv, "qa");
      return classifyHostRun(resolved.checkoutPath, stageSelector, stageSelector === "test" && stage.argv.length > 2);
    });
    const runClass = classifications.some(entry => entry.runClass === "heavy") ? "heavy" as const : "light" as const;
    const classification = {
      runClass,
      classSource: classifications.some(entry => entry.runClass === runClass && entry.classSource === "manifest")
        ? "manifest" as const : "default" as const,
    };
    const epoch = this.hostRuns.authority().epoch;
    // The supervisor's identity: a random per-run token it carries in its argv,
    // so a recycled pid can never be mistaken for it (task 114 review).
    const identityToken = randomUUID();
    const submittedAt = now();
    const startedAtMs = Date.parse(submittedAt);
    const record = projectQaRunSchema.parse({
      id,
      ...(allocation ? { checkoutPath: allocation } : {}),
      ...(input.submitterAgentId ? { submitterAgentId: input.submitterAgentId } : {}),
      repository: { origin: resolved.origin, path: resolved.path },
      key: resolved.key, state: "queued", baseBranch, base,
      argv, ...(qaSetting?.stages ? { stages } : {}),
      digest: digest(JSON.stringify(qaSetting?.stages ? stages.map(stage => ({ name: stage.name, argv: stage.argv, timeoutMs: stage.timeoutMs })) : argv)),
      exitCode: null, durationMs: 0, outputTail: "", startedAt: submittedAt, submittedAt, finishedAt: null, pid: null,
      terminationGraceMs,
      capacityWait: null, capacityUnavailable: false,
      hostRunEpoch: epoch, selector, runClass: classification.runClass, classSource: classification.classSource,
      priority: "milestone", runTimeoutMs: timeoutMs, maxOutputBytes,
      queuePosition: null,
    });
    const launch: ProjectQaLaunch = { ...resolved, baseBranch, base, argv, stages, timeoutMs, runClass: classification.runClass,
      maxOutputBytes, terminationGraceMs, id, caller, identityToken, startedAtMs, startedAt: submittedAt, epoch };
    const claimed = this.store.transaction(() => {
      const latest = this.store.latestQaRun(resolved.key);
      const selected = latest?.state === "running" || latest?.state === "queued" ? latest : record;
      if (selected === record && storageError)
        refuseQaAdmission("storage_unavailable", storageError instanceof Error ? storageError.message : String(storageError));
      admissionGuard?.(record, selected);
      if (input.expectedHead && selected.base !== input.expectedHead)
        refuseQaAdmission("existing_head_mismatch", `Existing QA run ${selected.id} is at a different head: ${selected.base}`);
      // Papercut 26636095: the QA admission fence refuses only a NEW run, here,
      // atomically with the claim. Joining an active run creates no work and an
      // accepted request replays before this point, so neither is fenced.
      const fence = selected === record ? this.store.qaFenceInForce() : null;
      if (fence) refuseQaAdmission("fence", qaFenceRefusal(fence));
      // The request is admitted only while it is still this runner's own
      // preparation: a settled request can never turn admitted afterwards.
      const persisted = this.store.getMeta<ProjectQaRequest>(`projectQaRequest:${request.id}`);
      if (persisted?.state !== "preparing" || persisted.ownerInstance !== request.ownerInstance)
        refuseQaAdmission("request_conflict", `QA request ${request.id} was settled during admission (${persisted?.state ?? "missing"}); no QA run was claimed`);
      if (selected === record) this.store.putQaRun(record);
      this.store.setMeta(`projectQaRequest:${request.id}`, { ...request, state: "admitted", runId: selected.id });
      return selected;
    });
    if (claimed.id !== record.id) {
      if (claimed.state === "queued") this.attachQueued(claimed);
      return claimed;
    }
    this.submitToHostScheduler(record, launch);
    return this.store.qaRun(id)!;
  },
};
