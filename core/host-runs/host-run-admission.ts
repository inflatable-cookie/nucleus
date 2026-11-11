import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  hostRunCapacitySampleSchema, hostRunInternalRecordSchema,
  type HostRunAuthority,
  type HostRunInternalRecord
} from "../../shared/contracts";
import { defaultBudgetFallback } from "./host-run-capacity";
import { redactHostRunData } from "./host-run-redact";
import type { HostRunHandler, HostRunSubmission } from "./host-run-scheduler-types";
import type { Store } from "../store/store";

type HostRunCapacitySample = ReturnType<typeof hostRunCapacitySampleSchema.parse>;

const repoKey = (repository: HostRunInternalRecord["repository"]) => repository.origin ?? repository.path;
function taskTableAdmission(text: string, selector: string): "heavy" | "light" | null {
  const table = /^\s*\[\s*tasks\.(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]\s*$/gm;
  const headers = [...text.matchAll(table)];
  for (let index = 0; index < headers.length; index++) {
    const match = headers[index];
    const name = match[1] ?? match[2] ?? match[3];
    if (name !== selector) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = headers[index + 1]?.index ?? text.length;
    const body = text.slice(start, end).split(/^\s*\[/m, 1)[0];
    const value = body.match(/^\s*admission\s*=\s*["'](heavy|light)["']\s*(?:#.*)?$/m)?.[1];
    return value === "heavy" || value === "light" ? value : null;
  }
  return null;
}

export function classifyHostRun(root: string, selector: string, filtered = false): { runClass: "heavy" | "light"; classSource: "manifest" | "default" } {
  const manifestSelector = selector.trim().split(/\s+/, 1)[0];
  const paths = [resolve(root, "effigy.toml")];
  const seen = new Set<string>();
  let manifestValue: "heavy" | "light" | null = null;
  for (let cursor = 0; cursor < paths.length && cursor < 64; cursor++) {
    const path = paths[cursor];
    if (seen.has(path)) continue;
    seen.add(path);
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    manifestValue = taskTableAdmission(text, manifestSelector) ?? manifestValue;
    const includeBlock = text.match(/^\s*include\s*=\s*\[([\s\S]*?)\]/m)?.[1];
    if (!includeBlock) continue;
    for (const include of includeBlock.matchAll(/["']([^"']+)["']/g)) {
      const requested = resolve(root, include[1]);
      const relativePath = requested.slice(resolve(root).length);
      if (relativePath && relativePath !== sep && !relativePath.startsWith(sep)) continue;
      paths.push(requested);
    }
  }
  if (manifestValue) return { runClass: manifestValue, classSource: "manifest" };
  const command = selector.trim();
  const heavy = command === "qa" || command === "ci" || command === "ci:fresh" || (command === "test" && !filtered);
  return { runClass: heavy ? "heavy" : "light", classSource: "default" };
}

interface HostRunAdmissionContext {
  authority(): HostRunAuthority;
  store: Store;
  handlers: Map<string, HostRunHandler>;
  scheduleDeadline(run: HostRunInternalRecord): void;
  startLaunch(run: HostRunInternalRecord, handler: HostRunHandler): void;
  pump(): void;
  nowMs: () => number;
  sampleCapacity(runs: HostRunInternalRecord[]): HostRunCapacitySample;
  resolveBudget(repository: HostRunInternalRecord["repository"], selector: string, fallback: { cpu: number; memoryBytes: number }, capacityBytes?: number, cpuCapacity?: number): HostRunInternalRecord["budget"];
  deadlineMs: number;
  assertCurrentEpoch(epoch: number): void;
  trackLive(run: HostRunInternalRecord): void;
}

export class HostRunAdmission {
  constructor(private readonly context: HostRunAdmissionContext) {}

  submit(input: HostRunSubmission, handler: HostRunHandler): HostRunInternalRecord {
    const authority = this.context.authority();
    if (input.epoch !== authority.epoch) throw new Error(`stale_epoch: expected ${authority.epoch}, received ${input.epoch}`);
    const existing = this.context.store.hostRun(input.id);
    if (existing) {
      if (existing.epoch !== input.epoch || existing.caller !== input.caller || existing.selector !== input.selector || repoKey(existing.repository) !== repoKey(input.repository)
          || input.clientRequestId !== undefined && existing.clientRequestId !== input.clientRequestId)
        throw new Error(`Host run ${input.id} already exists with different submission identity`);
      this.context.handlers.set(input.id, handler);
      this.context.scheduleDeadline(existing);
      if (existing.state === "admitted") this.context.startLaunch(existing, handler);
      else if (existing.state === "settled") handler.terminal?.(existing);
      this.context.pump();
      return this.context.store.hostRun(input.id)!;
    }
    const submittedMs = input.submittedAt ? Date.parse(input.submittedAt) : this.context.nowMs();
    if (!Number.isFinite(submittedMs)) throw new Error("Host-run submittedAt must be a valid timestamp");
    const submittedAt = new Date(submittedMs).toISOString();
    // The caller's own request, as the pinned `host.run.submit` stream input
    // allows it: the source Queue marks its submissions with and the Effigy run
    // id are Queue-internal identity, so they travel beside the input (durable
    // journal evidence, never a pinned request path) and the reservation's own
    // row carries neither.
    const { submissionSource: _submissionSource, effigyRunId: _effigyRunId, effigyRuntimeBinding: _binding, ...requestInput } = input;
    const internalIdentity = {
      ...(input.submissionSource ? { submissionSource: input.submissionSource } : {}),
      ...(input.effigyRunId ? { effigyRunId: input.effigyRunId } : {}),
    };
    const binding = input.effigyRuntimeBinding;
    const submissionInput = redactHostRunData({ ...requestInput, clientRequestId: input.clientRequestId ?? randomUUID() });
    const capacity = this.context.sampleCapacity([]);
    const fallback = input.budgetFallback ?? defaultBudgetFallback(capacity);
    const budget = this.context.resolveBudget(input.repository, input.selector, fallback, capacity.memoryCapacityBytes, capacity.cpuCapacity);
    const historicalWall = budget.wallMs;
    // A milestone QA timeout comes from the repository's explicit QA setting
    // (or the QA default). Historical wall time must not silently enlarge it:
    // the step executor enforces that same configured limit.
    const resolvedTimeout = historicalWall && input.priority !== "milestone"
      ? Math.max(input.runTimeoutMs, Math.ceil(historicalWall * 1.5)) : input.runTimeoutMs;
    const record = hostRunInternalRecordSchema.parse({
      id: input.id, epoch: input.epoch, submissionSource: input.submissionSource ?? "queue",
      ...(input.effigyRunId ? { effigyRunId: input.effigyRunId } : {}),
      ...(binding ? { effigyRuntime: {
        path: binding.identity.path, sha256: binding.identity.sha256, version: binding.version, workloadPath: binding.workloadPath, boundAt: submittedAt,
      } } : {}),
      caller: input.caller, clientRequestId: submissionInput.clientRequestId, repository: input.repository,
      selector: input.selector, runClass: input.runClass, classSource: input.classSource,
      priority: input.priority, state: "queued", submittedAt,
      capacityDeadlineAt: new Date(submittedMs + (input.capacityDeadlineMs ?? this.context.deadlineMs)).toISOString(),
      runTimeoutMs: resolvedTimeout, budgetFallback: fallback, budget,
      position: null, admittedAt: null, launchedAt: null, settledAt: null,
      capacitySample: null, pid: null, processGroupId: null, startIdentity: null,
      settlement: null, wallMs: null, cpuMs: null, containers: [],
      escapedDescendantsProvenDeadAt: null,
      capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null,
    });
    this.context.store.transaction(() => {
      this.context.assertCurrentEpoch(input.epoch);
      this.context.store.putHostRun(record);
      this.context.trackLive(record);
      this.context.store.appendHostRunJournal(record.id, "request", { method: "host.run.submit", input: submissionInput,
        runId: record.id, resolvedRunTimeoutMs: resolvedTimeout, budget, ...internalIdentity }, submittedAt);
      this.context.store.appendHostRunJournal(record.id, "submission", { ...submissionInput, runTimeoutMs: resolvedTimeout, budget,
        ...internalIdentity }, submittedAt);
      this.context.store.appendHostRunJournal(record.id, "classification", {
        runId: record.id, epoch: record.epoch, runClass: record.runClass, classSource: record.classSource, selector: record.selector,
      }, submittedAt);
      if (binding) this.context.store.appendHostRunJournal(record.id, "effigy_runtime_bind", {
        runId: record.id, epoch: record.epoch, path: binding.identity.path, sha256: binding.identity.sha256,
        workloadPath: binding.workloadPath, workloadPid: binding.workloadPid,
        workloadStartIdentity: binding.workloadStartIdentity, previousRefusal: null,
      }, submittedAt);
    });
    this.context.handlers.set(input.id, handler);
    this.context.scheduleDeadline(record);
    this.context.pump();
    return this.context.store.hostRun(input.id)!;
  }

  /** Claim an already-live pre-scheduler run during an upgrade; never launches it again. */
  adoptRunning(input: HostRunSubmission & { launchedAt: string; pid: number | null }): HostRunInternalRecord {
    const existing = this.context.store.hostRun(input.id);
    if (existing) return existing;
    const authority = this.context.authority();
    if (input.epoch !== authority.epoch) throw new Error(`stale_epoch: expected ${authority.epoch}, received ${input.epoch}`);
    const capacity = this.context.sampleCapacity(this.context.store.hostRunCapacityCandidates());
    const fallback = input.budgetFallback ?? defaultBudgetFallback(capacity);
    const submittedAt = input.submittedAt ?? input.launchedAt;
    const record = hostRunInternalRecordSchema.parse({
      id: input.id, epoch: input.epoch, caller: input.caller, repository: input.repository,
      selector: input.selector, runClass: input.runClass, classSource: input.classSource, priority: input.priority,
      state: "running", submittedAt, capacityDeadlineAt: new Date(Date.parse(submittedAt) + this.context.deadlineMs).toISOString(),
      runTimeoutMs: input.runTimeoutMs, budgetFallback: fallback, budget: this.context.resolveBudget(input.repository, input.selector, fallback, capacity.memoryCapacityBytes, capacity.cpuCapacity),
      position: null, admittedAt: input.launchedAt, launchedAt: input.launchedAt, settledAt: null,
      capacitySample: capacity, pid: input.pid, processGroupId: null, startIdentity: null, settlement: null,
      wallMs: null, cpuMs: null, containers: [], capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null,
    });
    this.context.store.transaction(() => {
      this.context.assertCurrentEpoch(input.epoch);
      this.context.store.putHostRun(record);
      this.context.trackLive(record);
      this.context.store.appendHostRunJournal(record.id, "decision", { runId: record.id, epoch: record.epoch, decision: "adopt_running", capacitySample: capacity }, input.launchedAt);
      this.context.store.appendHostRunJournal(record.id, "launch", { runId: record.id, epoch: record.epoch, adopted: true, launchedAt: input.launchedAt }, input.launchedAt);
    });
    return record;
  }
}
