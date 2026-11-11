/** Queue's step (a) implementation of Nucleus contract 010 host-run admission. */
import { realpathSync } from "node:fs";
import {
  hostRunAuthoritySchema,
  hostRunCapacitySampleSchema,
  type HostRunAccountingDisposeInput, type HostRunAccountingList, type HostRunAccountingRetirement, type HostRunAccountingView, type HostRunAuthority,
  type HostRunCpuCoverage, type HostRunEscapedDescendant, type HostRunInternalRecord,
  type HostRunPriority,
  type HostRunSettlement
} from "../../shared/contracts";
import type { EffigyRuntimeBinding } from "../qa/effigy-runtime";
import {
  HostRunAccounting,
  hostRunAccountingRetirementOf,
  type HostRunForegroundAbsenceRetirementInput, type HostRunProducerCleanupRetirementInput
} from "./host-run-accounting";
import { HostRunAdmission } from "./host-run-admission";
import { defaultHostCapacity, HostRunCapacity } from "./host-run-capacity";
import { HostRunLaunch } from "./host-run-launch";
import { HostRunQueueOrder } from "./host-run-queue-order";
import type { HostRunHandler, HostRunSchedulerOptions, HostRunSubmission } from "./host-run-scheduler-types";
import { HostRunSettlementOwner, stableJson } from "./host-run-settlement";
import { pidAlive } from "../machine/process-identity";
import { hostRunProcessStartIdentity } from "../machine/start-identity";
import type { Store } from "../store/store";
import { HISTORY_RETENTION_MS, now } from "../store/store";

export { classifyHostRun } from "./host-run-admission";
export { defaultBudgetFallback, HISTORY_MEMORY_MARGIN, HISTORY_MEMORY_SHARE_CAP, NO_HISTORY_CPU_SHARE, percentile95, selectorForArgv } from "./host-run-capacity";
export type { HostRunEvent, HostRunHandler, HostRunSchedulerOptions, HostRunSubmission } from "./host-run-scheduler-types";
export { HOST_RUN_ABANDONED_RELEASE_REASON, HOST_RUN_EXPIRED_RELEASE_REASON, HOST_RUN_SETTLEMENT_IDENTITY_READS_PER_SWEEP } from "./host-run-settlement";

export const HOST_RUN_CAPACITY_DEADLINE_MS = 30 * 60_000;
const AUTHORITY_JOURNAL_RUN_ID = "__host_run_authority__";
type HostRunAuthoritySnapshot = { holder: string; epoch: number; endpoint: string | null };
type HostRunCapacitySample = ReturnType<typeof hostRunCapacitySampleSchema.parse>;

export const HOST_RUN_ACCOUNTING_LIST_LIMIT = 1000;

/** One durable host scheduler per Queue store. */
export class HostRunScheduler {
  private static readonly byStore = new WeakMap<Store, HostRunScheduler>();
  static forStore(store: Store): HostRunScheduler {
    let scheduler = this.byStore.get(store);
    if (!scheduler) { scheduler = new HostRunScheduler(store); this.byStore.set(store, scheduler); }
    return scheduler;
  }

  private readonly handlers = new Map<string, HostRunHandler>();
  private readonly live = new Map<string, HostRunInternalRecord>();
  private readonly launching = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly nowMs: () => number;
  private readonly capacity: NonNullable<HostRunSchedulerOptions["capacity"]>;
  private readonly deadlineMs: number;
  private readonly hookAlive: (pid: number) => boolean;
  private readonly hookStartIdentity: (pid: number) => string;
  private launchPredicate: (run: HostRunInternalRecord) => boolean = () => true;
  setLaunchPredicate(predicate: (run: HostRunInternalRecord) => boolean) { this.launchPredicate = predicate; }
  private pumping = false;
  private pumpAgain = false;

  constructor(readonly store: Store, private readonly options: HostRunSchedulerOptions = {}) {
    this.nowMs = options.now ?? Date.now;
    this.capacity = options.capacity ?? defaultHostCapacity;
    this.deadlineMs = options.capacityDeadlineMs ?? HOST_RUN_CAPACITY_DEADLINE_MS;
    this.hookAlive = options.hookAlive ?? pidAlive;
    this.hookStartIdentity = options.hookStartIdentity ?? (pid => hostRunProcessStartIdentity(pid));
    for (const run of this.store.hostRunsByStates(["queued", "admitted", "running"])) this.live.set(run.id, run);
    this.ensureAuthority();
    this.store.observeHostRunAuthority((previous, value) => this.observeAuthority(previous, value));
    const authority = this.authoritySnapshot(this.store.getMeta<unknown>("hostRunAuthority"));
    if (authority) this.recordAuthority(authority);
  }

  /**
   * Contract-010 endpoint lifecycle evidence: the instant a process bound, first
   * answered, unbound, or swapped a staged socket onto the live path, as a journal
   * event (names and times only, never a path or payload). A make-before-break
   * roll records `endpoint_handoff` with bound/answered/swapped instants; the
   * client-visible gap is then the probe window around that swap, not unbound to
   * the next answered.
   */
  recordEndpointEvent(
    event: "endpoint_bound" | "endpoint_unbound" | "endpoint_answered" | "endpoint_handoff",
    at = new Date(this.nowMs()).toISOString(),
    extra: Record<string, unknown> = {},
  ): void {
    try {
      const data = { at, ...extra };
      this.store.appendHostRunJournal(AUTHORITY_JOURNAL_RUN_ID, event, data, at);
    } catch { /* Observational evidence never rejects a bind or a stop. */ }
  }

  authority(): HostRunAuthority {
    const value = this.store.getMeta<unknown>("hostRunAuthority");
    const parsed = hostRunAuthoritySchema.safeParse(value);
    if (!parsed.success || parsed.data.holder !== "queue") throw new Error("Nucleus is not the current host-run scheduler authority");
    return parsed.data;
  }

  private assertCurrentEpoch(epoch: number): void {
    const current = hostRunAuthoritySchema.safeParse(this.store.getMeta<unknown>("hostRunAuthority"));
    if (!current.success || current.data.holder !== "queue") throw new Error("Nucleus is not the current host-run scheduler authority");
    if (current.data.epoch !== epoch) throw new Error(`stale_epoch: expected ${current.data.epoch}, received ${epoch}`);
  }

  private currentEpoch(epoch: number): boolean {
    try { this.assertCurrentEpoch(epoch); return true; } catch { return false; }
  }

  private ensureAuthority(): void {
    const current = this.store.getMeta<unknown>("hostRunAuthority");
    if (current === undefined) {
      this.store.setMeta("hostRunAuthority", { holder: "queue", epoch: 1, endpoint: null } satisfies HostRunAuthority);
      return;
    }
    const parsed = hostRunAuthoritySchema.safeParse(current);
    if (!parsed.success || parsed.data.holder !== "queue") throw new Error("Host-run authority is held by another scheduler");
  }

  private authoritySnapshot(value: unknown): HostRunAuthoritySnapshot | null {
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.holder !== "string" || !candidate.holder || !Number.isSafeInteger(candidate.epoch)
        || (candidate.epoch as number) < 1 || !(candidate.endpoint === null || typeof candidate.endpoint === "string")) return null;
    return { holder: candidate.holder, epoch: candidate.epoch as number, endpoint: candidate.endpoint };
  }

  private observeAuthority(previousValue: unknown, value: unknown): void {
    const previous = this.authoritySnapshot(previousValue);
    const next = this.authoritySnapshot(value);
    if (!next || stableJson(next) === stableJson(previous)) return;
    this.recordAuthority(next);
  }

  private recordAuthority(authority: HostRunAuthoritySnapshot): number | null {
    try {
      const at = now();
      return this.store.appendHostRunJournal(AUTHORITY_JOURNAL_RUN_ID, "authority", authority, at);
    } catch { /* Authority evidence is observational; it cannot reject a scheduler start or handoff. */ return null; }
  }

  get(id: string): HostRunInternalRecord | null { return this.store.hostRun(id); }
  /** Current scheduler set for read-only projections; deliberately excludes history. */
  liveRuns(): HostRunInternalRecord[] { return [...this.live.values()]; }
  private trackLive(run: HostRunInternalRecord): void {
    if (run.state === "settled") this.live.delete(run.id);
    else this.live.set(run.id, run);
  }

  /**
   * Internal read of a settled run's CPU reason: present only when the stored
   * reason names this row's epoch and cpuMs and agrees with it. Never on the wire.
   */
  cpuCoverage(id: string): HostRunCpuCoverage | undefined { return this.capacityOwner.cpuCoverage(id); }
  /** A live client-protocol run whose submitted cwd is this worker's worktree. */
  liveClientRunAt(directory: string | null | undefined): HostRunInternalRecord | null {
    if (!directory) return null;
    let target: string;
    try { target = realpathSync(directory); } catch { return null; }
    const active = this.store.hostRunsByStates(["queued", "admitted", "running"]);
    for (const run of active) {
      const fromClient = run.submissionSource === "client" || this.store.hostRunJournal(run.id).some(entry => {
        const data = entry.data as { method?: unknown } | null;
        return entry.event === "request" && data?.method === "host.run.client.submit";
      });
      if (!fromClient) continue;
      try { if (realpathSync(run.repository.path) === target) return run; } catch { /* Missing cwd cannot establish liveness. */ }
    }
    return null;
  }
  /**
   * A live Queue- or client-submitted host run at this cwd. Admission uses this
   * to skip a second slot for already-reserved QA, validation and host-run
   * client work. Concurrent admission reservations at the same cwd stay distinct.
   */
  liveQueueOrClientRunAt(directory: string | null | undefined): HostRunInternalRecord | null {
    if (!directory) return null;
    let target: string;
    try { target = realpathSync(directory); } catch { return null; }
    const active = this.store.hostRunsByStates(["queued", "admitted", "running"]);
    for (const run of active) {
      if (run.submissionSource === "admission") continue;
      const fromClient = run.submissionSource === "client" || this.store.hostRunJournal(run.id).some(entry => {
        const data = entry.data as { method?: unknown } | null;
        return entry.event === "request" && data?.method === "host.run.client.submit";
      });
      const fromQueue = run.submissionSource === "queue" || run.submissionSource === undefined;
      if (!fromClient && !fromQueue) continue;
      try { if (realpathSync(run.repository.path) === target) return run; } catch { /* Missing cwd cannot establish liveness. */ }
    }
    return null;
  }
  list(limit = 250): HostRunInternalRecord[] {
    const recent = this.store.hostRuns(limit);
    const visible = new Map(recent.map(run => [run.id, run]));
    // A run whose accounting was retired keeps unknown custody, so it stays
    // visible beyond ordinary history like the reserving rows, but only for
    // HISTORY_RETENTION_MS after its own disposedAt; after that ordinary recency
    // decides, as for a settled run (Tom, 2026-10-25: "Age out at 4 days";
    // Spec 035 "Retired runs age out, and dead foreground runs retire"). A
    // still-charged admitted or running row stays listed however old, and so
    // does a still-charged queued reservation waiting for a slot: it is not a
    // capacity candidate, so the queued set is walked separately. The row and
    // its retirement are never rewritten or deleted.
    const retiredSince = this.nowMs() - HISTORY_RETENTION_MS;
    for (const run of this.store.hostRunCapacityCandidates()) {
      if (this.reservesCapacity(run)) { visible.set(run.id, run); continue; }
      const retirement = hostRunAccountingRetirementOf(this.store, run);
      if (retirement && Date.parse(retirement.disposedAt) >= retiredSince) visible.set(run.id, run);
    }
    for (const run of this.store.hostRunsByStates(["queued"])) visible.set(run.id, run);
    return [...visible.values()].sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt) || right.id.localeCompare(left.id));
  }

  submit(input: HostRunSubmission, handler: HostRunHandler): HostRunInternalRecord { return this.admissionOwner.submit(input, handler); }

  /** Register a durable queued run after a service roll, then retry admission. */
  attach(id: string, handler: HostRunHandler): HostRunInternalRecord | null {
    const run = this.store.hostRun(id);
    if (!run) return null;
    this.assertCurrentEpoch(run.epoch);
    this.handlers.set(id, handler);
    this.scheduleDeadline(run);
    if (run.state === "admitted") this.startLaunch(run, handler);
    else if (run.state === "settled") handler.terminal?.(run);
    this.pump();
    return this.store.hostRun(id);
  }

  /** Claim an already-live pre-scheduler run during an upgrade; never launches it again. */
  adoptRunning(input: HostRunSubmission & { launchedAt: string; pid: number | null }): HostRunInternalRecord { return this.admissionOwner.adoptRunning(input); }

  updateProcess(id: string, process: { pid: number; processGroupId: number | null; startIdentity: string | null }): HostRunInternalRecord {
    const current = this.store.hostRun(id);
    if (!current || current.state !== "running") throw new Error(`Host run ${id} is not running`);
    if (current.pid === process.pid && current.processGroupId === process.processGroupId && current.startIdentity === process.startIdentity)
      return current;
    const updated = { ...current, ...process };
    return this.persist(updated, "launched", { pid: process.pid, pgid: process.processGroupId, startIdentity: process.startIdentity }, now(), current.epoch);
  }

  /** Record the admission hook's pid+start identity while the reservation is still live. */
  bindProcess(id: string, process: { pid: number; processGroupId: number | null; startIdentity: string | null }): HostRunInternalRecord {
    const current = this.store.hostRun(id);
    if (!current || current.state === "settled") throw new Error(`Host run ${id} is not live`);
    if (current.pid === process.pid && current.processGroupId === process.processGroupId && current.startIdentity === process.startIdentity)
      return current;
    return this.persist({ ...current, ...process }, "admission_hook_bind", {
      pid: process.pid, pgid: process.processGroupId, startIdentity: process.startIdentity,
    }, now(), current.epoch);
  }

  /**
   * Record the verified Effigy runtime behind an already-written reservation, or
   * why none could be bound (Spec 035, "Runtime identity"). A new admission no
   * longer takes this path: `submit` writes its binding in the row's own durable
   * write, because an unbound admission is refused before it reserves. This
   * remains for reservations written before that boundary. First binding wins; a
   * verified binding replaces an earlier refusal, because a later qualified
   * attestation is still true. A settled row is never rewritten.
   */
  bindEffigyRuntime(id: string, binding: EffigyRuntimeBinding): HostRunInternalRecord {
    const current = this.store.hostRun(id);
    if (!current || current.state === "settled") throw new Error(`Host run ${id} is not live`);
    if (binding.kind === "bound") {
      if (current.effigyRuntime) return current;
      const boundAt = now();
      const cleared = { ...current };
      delete cleared.effigyRuntimeRefusal;
      return this.persist({ ...cleared, effigyRuntime: {
        path: binding.identity.path, sha256: binding.identity.sha256, version: binding.version,
        workloadPath: binding.workloadPath, boundAt,
      } }, "effigy_runtime_bind", {
        path: binding.identity.path, sha256: binding.identity.sha256, version: binding.version, workloadPath: binding.workloadPath,
        workloadPid: binding.workloadPid, workloadStartIdentity: binding.workloadStartIdentity,
        previousRefusal: current.effigyRuntimeRefusal ?? null,
      }, boundAt, current.epoch);
    }
    if (current.effigyRuntime || current.effigyRuntimeRefusal === binding.reason) return current;
    return this.persist({ ...current, effigyRuntimeRefusal: binding.reason }, "effigy_runtime_unbound",
      { reason: binding.reason }, now(), current.epoch);
  }

  /** Durable launch boundary. Call immediately before the supervisor/process side effect. */
  markLaunched(id: string, canLaunch?: (run: HostRunInternalRecord) => boolean): HostRunInternalRecord { return this.launchOwner.markLaunched(id, canLaunch); }

  settle(id: string, settlement: HostRunSettlement, metrics: { wallMs?: number | null; cpuMs?: number | null; cpuCoverage?: HostRunCpuCoverage } = {},
    atomicWrite?: () => void): HostRunInternalRecord { return this.settlementOwner.settle(id, settlement, metrics, atomicWrite); }

  cancelQueued(id: string, reason: string, epoch: number): HostRunInternalRecord { return this.settlementOwner.cancelQueued(id, reason, epoch); }

  rejectBeforeLaunch(id: string, reason: string): HostRunInternalRecord { return this.settlementOwner.rejectBeforeLaunch(id, reason); }

  /**
   * Queue-internal read of a run's accounting state (Spec 035, "Operator
   * accounting disposition"): the pinned record beside the durable disposition,
   * or null for an unknown run. Never a wire shape of contract 010.
   */
  accountingStatus(id: string): HostRunAccountingView | null { return this.accountingOwner.accountingStatus(id); }

  /**
   * The board's bounded bulk accounting read (Spec 035, "Retired runs on the
   * board"): the unsettled rows with a stored retirement among exactly the rows
   * `list()` returns, newest first, so it covers the runs the board shows and
   * nothing older (Tom, 2026-10-25: "Age out at 4 days"). A retirement this
   * build can bind to the row's id and epoch reads `retired`; any other stored
   * record reads `unreadable`, so that run stays charged and live. A row this
   * read does not return is charged; `complete` says whether it returned every
   * candidate. Nothing is written and the pinned row is untouched.
   */
  accountingList(limit = HOST_RUN_ACCOUNTING_LIST_LIMIT, listLimit?: number): HostRunAccountingList {
    return this.accountingOf(this.list(listLimit), limit);
  }
  /**
   * The board's one combined read (audit A8): exactly the rows `list()` returns and
   * exactly the accounting entries `accountingList()` derives, from a single list
   * call instead of two. Each entry keeps the same id and epoch join and the same
   * conservative unreadable answer, and `complete` keeps its meaning for the
   * entries this read covers. Nothing is written and the pinned `host.run.list`
   * record, its schema and both method digests are untouched.
   */
  boardState(limit?: number, accountingLimit = HOST_RUN_ACCOUNTING_LIST_LIMIT): { runs: HostRunInternalRecord[]; accounting: HostRunAccountingList } {
    const runs = this.list(limit);
    return { runs, accounting: this.accountingOf(runs, accountingLimit) };
  }
  /** The accounting entries for rows already read; the single join both board reads use. */
  private accountingOf(runs: HostRunInternalRecord[], limit: number): HostRunAccountingList { return this.accountingOwner.accountingOf(runs, limit); }

  /**
   * Retire one launched reservation's ACCOUNTING while its workload outcome and
   * runtime custody stay UNKNOWN (Spec 035, "Operator accounting disposition").
   *
   * This is the general operator surface the settled-only `releaseCapacity`
   * never covered: an admission reservation admitted before a trusted runtime
   * binding existed can be running with no honest terminal result, and used to
   * charge capacity forever. The row is never rewritten and no settlement, exit,
   * custody, container, descendant, workspace or consumer permission changes: the
   * scheduler stops charging this reservation's budget and records who decided
   * it, the separate exact-run/current-epoch acceptance and the evidence it saw.
   *
   * Only an operator (or an authenticated relay with the operator's note) is
   * authority; generic approval is not acceptance. The exact pinned record
   * digest the caller read must still hold, so a changed row refuses instead of
   * being disposed of on stale evidence, and the durable operation id makes a
   * lost reply observable by repeating the same call rather than a blind replay
   * or a fresh key.
   */
  disposeAccounting(input: HostRunAccountingDisposeInput): HostRunAccountingView { return this.accountingOwner.disposeAccounting(input); }

  /**
   * Retire one launched reservation's ACCOUNTING because the producer reported
   * that exact run's cleanup complete (Spec 035, "Automatic accounting on
   * producer cleanup").
   *
   * This is the automatic path the #415 closure gates feed: the observer has
   * already read a `checkout-journal` record for this reservation's own Effigy
   * run id and selector, with `cleanup: complete` and a workload verdict, using
   * the reservation's bound runtime bytes in its own checkout. What arrives here
   * is that producer record — evidence, not a Contract 010 result.
   *
   * The row is never rewritten: Queue supervised no admitted command, so it holds
   * no result record, no process-group identity, no container or escaped-
   * descendant inventory and no custody closure. The retired charge is recorded in
   * the same private sidecar the operator disposition uses, as an automatic
   * retirement naming the policy ruling and the exact producer record, and the
   * pinned contract 010 row, `host.run.list` and `host.run.capacity.release` stay
   * byte for byte what they were. Accounting stops; outcome and custody stay
   * UNKNOWN.
   *
   * Idempotent by construction: an already-stored retirement bound to this row
   * and epoch is returned as itself and nothing is written again, so a repeated
   * tick, a restart, a lost reply and a concurrent pass cannot double-retire. A
   * stored retirement this build cannot read leaves the run charged and refuses
   * rather than replacing it. Every refusal writes nothing.
   */
  retireAccountingOnProducerCleanup(input: HostRunProducerCleanupRetirementInput): {
    kind: "retired" | "already_retired";
    view: HostRunAccountingView;
    retirement: HostRunAccountingRetirement;
  } { return this.accountingOwner.retireAccountingOnProducerCleanup(input); }

  /**
   * Retire one launched reservation's ACCOUNTING because its admission hook is
   * dead and the producer reports no foreground holder and no journal record of
   * its run (Spec 035, "Retired runs age out, and dead foreground runs retire";
   * Tom, 2026-10-25: "Auto-free them (Recommended)").
   *
   * Same discipline as the producer-cleanup retirement: the pinned row is never
   * rewritten, the record and its journal fact commit together, an already
   * stored retirement bound to the row is returned as itself, and every binding
   * (epoch, launch, run id, selector, checkout, runtime bytes, hook identity) is
   * re-checked here so evidence read before an await cannot retire a row that
   * moved. Accounting only: outcome and custody stay UNKNOWN.
   */
  retireAccountingOnForegroundAbsence(input: HostRunForegroundAbsenceRetirementInput): {
    kind: "retired" | "already_retired";
    view: HostRunAccountingView;
    retirement: HostRunAccountingRetirement;
  } { return this.accountingOwner.retireAccountingOnForegroundAbsence(input); }

  /**
   * Settle the launched admission reservation `id` when the admission hook it
   * recorded is gone (Spec 035, "A reservation settles when its recorded
   * process is gone"). This is the watcher's side of the rule: the endpoint has
   * just read the row's producer answer, so the reservation's own recorded
   * process being absent is the whole question. Returns the settled row, or null
   * when nothing is due: a live hook, an unprovable hook identity, a row that is
   * not a launched admission, or a row already settled. Idempotent by that last
   * check, so a repeated tick writes nothing again.
   *
   * The hook is the foreground process Queue recorded for this reservation and it
   * holds until it is terminated, so its absence is the end of that foreground.
   * The settlement claims nothing about the workload: it is the pinned record's
   * `lost` — launched, no result, no process-group identity, no containers, no
   * escaped descendants — and one `hook_gone` journal fact names the dead
   * identity, custody unknown, and the producer's own terminal answer when the
   * row already holds one. Capacity is released under the settlement's own
   * reason unless this row already records a release, which keeps its original
   * one.
   */
  settleAbandonedAdmission(id: string): HostRunInternalRecord | null { return this.settlementOwner.settleAbandonedAdmission(id); }

  /**
   * The ordinary sweep behind `tick()`, and the restart path for rows no watch
   * covers (Spec 035, "A reservation settles when its recorded process is
   * gone"): every launched admission reservation whose hook is gone settles
   * once, and the freed capacity is offered to the queue.
   *
   * The sweep settles the two shapes whose evidence is already final without
   * asking a producer again: the row's own producer retired its accounting, or
   * its recorded run timeout has passed. A row the producer still reports live,
   * held or retained keeps that hold until its deadline; a row with no producer
   * answer yet is left to the watch that owns it, so the sweep never settles a
   * reservation one instant before its own observer reads the result. A bounded
   * page of start-identity reads keeps a busy pass from stalling the service;
   * anything it leaves unproven waits for the next tick.
   */
  sweepAbandonedAdmissions(): HostRunInternalRecord[] { return this.settlementOwner.sweepAbandonedAdmissions(); }

  private settleIfDue(run: HostRunInternalRecord, budget: { identityReads: number }, scope: "watch" | "sweep"): HostRunInternalRecord | null { return this.settlementOwner.settleIfDue(run, budget, scope); }

  /** True when this row already carries its producer's own accounting retirement. */
  private reservationAccountingRetired(run: HostRunInternalRecord): boolean { return this.settlementOwner.reservationAccountingRetired(run); }

  /**
   * The recorded admission hook's liveness: `gone` only on positive absence,
   * `unknown` whenever this host cannot prove either way.
   *
   * A pid the kernel no longer reports is positive absence, whatever the
   * recorded identity says, because no identity read can make a dead pid alive.
   * A live pid is only `alive` when its identity still matches — a reused number
   * is `gone` — and an unreadable identity, or a pass that has spent its bounded
   * reads, is `unknown` and never absence.
   */
  private admissionHookState(run: HostRunInternalRecord, budget: { identityReads: number }): "gone" | "alive" | "unknown" { return this.settlementOwner.admissionHookState(run, budget); }

  /**
   * One writer for both honest exits of an abandoned reservation: the producer
   * closed the accounting (`hook_gone`) and the deadline that outlives a
   * producer still claiming the run (`expiry`).
   */
  private writeSettlement(run: HostRunInternalRecord, event: "hook_gone" | "expiry", reason: string): HostRunInternalRecord | null { return this.settlementOwner.writeSettlement(run, event, reason); }

  /**
   * The producer's own terminal answer this reservation already holds, when it
   * holds one: the automatic retirement its bound runtime's `checkout-journal`
   * record produced (`cleanup: complete` and the producer's verdict). It travels
   * in the settlement's journal fact as evidence beside Queue's own `lost`,
   * because a producer's verdict about a workload Queue never supervised is not
   * a contract 010 result and is never written as one.
   */
  private recordedProducerResult(run: HostRunInternalRecord) { return this.settlementOwner.recordedProducerResult(run); }

  releaseCapacity(id: string, reason: string): HostRunInternalRecord { return this.settlementOwner.releaseCapacity(id, reason); }

  /** Record identity-based proof that every escaped descendant has exited. */
  markEscapedDescendantsDead(id: string, provenDead: HostRunEscapedDescendant[]): HostRunInternalRecord { return this.settlementOwner.markEscapedDescendantsDead(id, provenDead); }

  /** Part 3's durable report seam; container capacity is keyed by run/runtime/container. */
  reportContainerFact(fact: { factId: string; observedAt: string; runId: string; epoch: number; runtime: string; containerId: string; event: "started" | "removed"; removed?: boolean | "unknown" }): HostRunInternalRecord { return this.settlementOwner.reportContainerFact(fact); }

  /**
   * Public seam for the contract 010 client-protocol endpoint: commit one fact
   * to the ordered journal. The run may be a synthetic holder for facts with no
   * host run (an operator override).
   */
  note(runId: string, event: string, data: Record<string, unknown>): void {
    this.store.appendHostRunJournal(runId, event, { runId, ...data }, now());
  }

  /**
   * Reconcile deadlines, abandoned reservations, admission and queue positions.
   * Called by the Queue timer (and by recovery passes and tests that drive the
   * same sweep), so the first pass after a restart settles what the previous
   * process left behind. Settling runs only here, never inside a write's own
   * pump, so one settlement never re-walks every row another settlement just
   * looked at.
   */
  tick(): void { this.sweepAbandonedAdmissions(); this.pump(); }

  /** Contract 010 client-protocol `status {}` host summary. */
  summary(): {
    sampledAt: string; cpuCapacity: number; memoryCapacityBytes: number;
    reservedCpu: number; reservedMemoryBytes: number; freeMemoryBytes: number; loadAverage: number[];
    running: number; admitted: number; queued: number;
  } {
    const candidates = this.store.hostRunCapacityCandidates();
    const sample = this.sampleCapacity(candidates);
    return { ...sample,
      running: candidates.filter(run => run.state === "running").length,
      admitted: candidates.filter(run => run.state === "admitted").length,
      queued: this.store.hostRunsByStates(["queued"]).length };
  }

  /** Stop this service owner's timers; durable queued rows attach on the next owner. */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.handlers.clear();
  }

  private sampleCapacity(runs: HostRunInternalRecord[]): HostRunCapacitySample { return this.capacityOwner.sampleCapacity(runs); }

  private reservesCapacity(run: HostRunInternalRecord): boolean { return this.capacityOwner.reservesCapacity(run); }

  private hasUnresolvedEscapedDescendants(run: HostRunInternalRecord): boolean { return this.capacityOwner.hasUnresolvedEscapedDescendants(run); }

  private resolveBudget(repository: HostRunInternalRecord["repository"], selector: string, fallback: { cpu: number; memoryBytes: number }, capacityBytes?: number, cpuCapacity?: number): HostRunInternalRecord["budget"] { return this.capacityOwner.resolveBudget(repository, selector, fallback, capacityBytes, cpuCapacity); }

  private historicalSamples(repository: HostRunInternalRecord["repository"], selector: string): Array<{ cpuMs: number | null; wallMs: number; memoryBytes: number | null }> { return this.capacityOwner.historicalSamples(repository, selector); }

  private priorityValue(priority: HostRunPriority): number { return this.queueOrderOwner.priorityValue(priority); }
  private startLaunch(run: HostRunInternalRecord, handler: HostRunHandler): void { return this.launchOwner.startLaunch(run, handler); }
  private orderedQueued(): HostRunInternalRecord[] { return this.queueOrderOwner.orderedQueued(); }

  private pump(): void {
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const nowMs = this.nowMs();
        for (const queued of this.store.hostRunsByStates(["queued", "admitted"]).filter(run => Date.parse(run.capacityDeadlineAt) <= nowMs))
          if (this.currentEpoch(queued.epoch)) this.capacityTimeout(queued);
        let all = this.store.hostRunCapacityCandidates();
        const ordered = this.orderedQueued();
        let nextPosition = 0;
        for (const candidate of ordered) {
          if (!this.currentEpoch(candidate.epoch)) continue;
          const sample = this.sampleCapacity(all);
          const fits = sample.reservedCpu + candidate.budget.cpu <= sample.cpuCapacity
            && sample.reservedMemoryBytes + candidate.budget.memoryBytes <= sample.memoryCapacityBytes;
          if (!fits) {
            nextPosition++;
            if (candidate.position !== nextPosition) {
              const positioned = this.persistFenced({ ...candidate, position: nextPosition, capacitySample: sample }, "decision", {
                decision: "queue_position", position: nextPosition, capacitySample: sample,
              }, now());
              if (!positioned) continue;
              this.handlers.get(candidate.id)?.position?.(nextPosition, positioned);
            }
            continue;
          }
          const at = new Date(nowMs).toISOString();
          const admitted = this.persistFenced({ ...candidate, state: "admitted", position: null, admittedAt: at, capacitySample: sample }, "decision", {
            decision: "admit", capacitySample: sample, budget: candidate.budget,
          }, at);
          if (!admitted) continue;
          all = this.store.hostRunCapacityCandidates();
          const handler = this.handlers.get(candidate.id);
          if (handler) this.startLaunch(admitted, handler);
        }
      } while (this.pumpAgain);
    } finally { this.pumping = false; }
  }

  private failLaunch(id: string, error: unknown): void { return this.launchOwner.failLaunch(id, error); }

  private capacityTimeout(run: HostRunInternalRecord): void { return this.settlementOwner.capacityTimeout(run); }

  private scheduleDeadline(run: HostRunInternalRecord): void {
    if ((run.state !== "queued" && run.state !== "admitted") || this.timers.has(run.id)) return;
    const wait = Math.max(0, Date.parse(run.capacityDeadlineAt) - this.nowMs());
    const timer = setTimeout(() => { this.timers.delete(run.id); this.pump(); }, wait);
    timer.unref?.();
    this.timers.set(run.id, timer);
  }
  private clearDeadline(id: string): void { const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id); }

  private persist(run: HostRunInternalRecord, event: string, data: unknown, at = now(), expectedEpoch?: number): HostRunInternalRecord {
    const details = data && typeof data === "object" ? data as Record<string, unknown> : { value: data };
    return this.persistMany(run, [{ event, data: details }], at, expectedEpoch);
  }
  /** Commit a run transition and every resulting fact before publishing any of them. */
  private persistMany(run: HostRunInternalRecord, entries: Array<{ event: string; data: Record<string, unknown> }>, at = now(), expectedEpoch?: number,
    atomicWrite?: () => void): HostRunInternalRecord {
    this.store.transaction(() => {
      if (expectedEpoch !== undefined) this.assertCurrentEpoch(expectedEpoch);
      this.store.putHostRun(run);
      this.trackLive(run);
      atomicWrite?.();
      for (const entry of entries)
        this.store.appendHostRunJournal(run.id, entry.event, { runId: run.id, epoch: run.epoch, ...entry.data }, at);
    });
    return run;
  }
  /** A pump/timer race with an authority handoff is a fenced no-op, not a service error. */
  private persistFenced(run: HostRunInternalRecord, event: string, data: unknown, at: string): HostRunInternalRecord | null {
    try { return this.persist(run, event, data, at, run.epoch); }
    catch (error) {
      if (!this.currentEpoch(run.epoch)) return null;
      throw error;
    }
  }
  private recordEvent(run: HostRunInternalRecord, event: string, data: Record<string, unknown>, at = now()): void {
    const journalData = { runId: run.id, epoch: run.epoch, ...data };
    this.store.appendHostRunJournal(run.id, event, journalData, at);
  }

  private get admissionOwner(): HostRunAdmission {
    return new HostRunAdmission({
      authority: this.authority.bind(this),
      store: this.store,
      handlers: this.handlers,
      scheduleDeadline: this.scheduleDeadline.bind(this),
      startLaunch: this.startLaunch.bind(this),
      pump: this.pump.bind(this),
      nowMs: this.nowMs.bind(this),
      sampleCapacity: this.sampleCapacity.bind(this),
      resolveBudget: this.resolveBudget.bind(this),
      deadlineMs: this.deadlineMs,
      assertCurrentEpoch: this.assertCurrentEpoch.bind(this),
      trackLive: this.trackLive.bind(this),
    });
  }

  private get queueOrderOwner(): HostRunQueueOrder {
    return new HostRunQueueOrder({
      store: this.store,
      handlers: this.handlers,
      nowMs: this.nowMs.bind(this),
      priorityValue: this.priorityValue.bind(this),
    });
  }

  private get capacityOwner(): HostRunCapacity {
    return new HostRunCapacity({
      capacity: this.capacity.bind(this),
      reservesCapacity: this.reservesCapacity.bind(this),
      nowMs: this.nowMs.bind(this),
      hasUnresolvedEscapedDescendants: this.hasUnresolvedEscapedDescendants.bind(this),
      store: this.store,
      historicalSamples: this.historicalSamples.bind(this),
    });
  }

  private get launchOwner(): HostRunLaunch {
    return new HostRunLaunch({
      store: this.store,
      assertCurrentEpoch: this.assertCurrentEpoch.bind(this),
      nowMs: this.nowMs.bind(this),
      launchPredicate: this.launchPredicate.bind(this),
      trackLive: this.trackLive.bind(this),
      sampleCapacity: this.sampleCapacity.bind(this),
      handlers: this.handlers,
      clearDeadline: this.clearDeadline.bind(this),
      pump: this.pump.bind(this),
      currentEpoch: this.currentEpoch.bind(this),
      launching: this.launching,
      failLaunch: this.failLaunch.bind(this),
      rejectBeforeLaunch: this.rejectBeforeLaunch.bind(this),
      recordEvent: this.recordEvent.bind(this),
    });
  }

  private get settlementOwner(): HostRunSettlementOwner {
    return new HostRunSettlementOwner({
      store: this.store,
      persistMany: this.persistMany.bind(this),
      handlers: this.handlers,
      clearDeadline: this.clearDeadline.bind(this),
      pump: this.pump.bind(this),
      assertCurrentEpoch: this.assertCurrentEpoch.bind(this),
      sampleCapacity: this.sampleCapacity.bind(this),
      settleIfDue: this.settleIfDue.bind(this),
      nowMs: this.nowMs.bind(this),
      reservationAccountingRetired: this.reservationAccountingRetired.bind(this),
      admissionHookState: this.admissionHookState.bind(this),
      writeSettlement: this.writeSettlement.bind(this),
      hookAlive: this.hookAlive.bind(this),
      hookStartIdentity: this.hookStartIdentity.bind(this),
      hasUnresolvedEscapedDescendants: this.hasUnresolvedEscapedDescendants.bind(this),
      recordedProducerResult: this.recordedProducerResult.bind(this),
      currentEpoch: this.currentEpoch.bind(this),
      authority: this.authority.bind(this),
      persist: this.persist.bind(this),
      trackLive: this.trackLive.bind(this),
    });
  }

  private get accountingOwner(): HostRunAccounting {
    return new HostRunAccounting({
      store: this.store,
      nowMs: this.nowMs.bind(this),
      authority: this.authority.bind(this),
      pump: this.pump.bind(this),
    });
  }
}
