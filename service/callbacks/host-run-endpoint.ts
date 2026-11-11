import {
  runtimeNodeArgs,
} from "../../shared/runtime.mjs";
import {
  HostRunAttach,
} from "../../core/host-runs/host-run-attach";
import {
  HOST_RUN_CLIENT_PROTOCOL_VERSION,
  HOST_RUN_FACT_CACHE_BYTES,
  HOST_RUN_FACT_CACHE_ENTRIES,
  HOST_RUN_MAX_REQUEST_BYTES,
  HOST_RUN_OUTPUT_RETENTION_MS,
  HOST_RUN_RECONNECT_WINDOW_MS,
  HOST_RUN_SUPERVISOR_POLL_MS,
  HOST_RUN_TERMINATION_GRACE_MS,
  HOST_RUN_TOKEN_GRACE_MS,
  HOST_RUN_UNLAUNCHED_GRACE_MS,
  HostRunClientErrorCode,
  HostRunSupervisorSpawn,
  StoredSubmission,
  errorText,
  stableJson,
  storedBodyOf,
} from "../../core/host-runs/host-run-endpoint-types";
import {
  appendVerifiedOwnedFile,
  defaultHostRunStateDir,
  ensureVerifiedDirectoryChain,
  hostRunSupervisorPaths,
  openVerifiedOwnedFile,
  readCheckedHostRunFile,
  writeVerifiedOwnedFile,
} from "../../core/host-runs/host-run-files";
import {
  HostRunRetention,
} from "../../core/host-runs/host-run-retention";
import {
  HostRunWatch,
} from "../../core/host-runs/host-run-watch";
import {
  HostRunServing,
} from "./host-run-serving";
import {
  HOST_RUN_KEYS_FORMAT,
  readHostRunTokenKeys,
  signRunToken,
  type HostRunTokenKeys,
} from "../../core/host-runs/host-run-token";
import {
  HOST_RUN_SUPERVISOR_PLAN_FORMAT,
  hostRunCancelBodySchema,
  hostRunCancelRequestSchema,
  hostRunFactSchema,
  hostRunLaunchEnvironment,
  hostRunReportBodySchema,
  hostRunStatusBodySchema,
  hostRunSubmitBodySchema,
  hostRunSupervisorPlanSchema,
  readHostRunLaunchEnv,
  removeHostRunLaunchEnv,
  storedBodySchema,
  writeHostRunLaunchEnv,
  type HostRunFact,
  type HostRunSupervisorPlan,
} from "../../core/host-runs/host-run-wire";
export * from "../../core/host-runs/host-run-files";
export * from "../../core/host-runs/host-run-token";
export * from "../../core/host-runs/host-run-wire";
/**
 * Queue's server side of Nucleus contract 010's "Client protocol v1"
 * (Spec 035 part 3). The host-run scheduler owns admission, the journal and the
 * runs; this module owns the wire boundary the Effigy client speaks:
 *
 * - the owner-only discovery files under the configured host-run state root
 *   (`authority.json`, `token.key`, `run/scheduler.sock`);
 * - newline-delimited JSON over that socket: `submit`, `attach`, `cancel`,
 *   `status` and `report`, with contract 010's error codes and client actions;
 * - the HMAC run token (`HOST_RUN_TOKEN`) and the allowlisted launch environment;
 * - per-run output retention with byte offsets, and the 5 s reconnect window
 *   behind `cancelOnDisconnect`, and the 60 s grace after which a never-launched
 *   run whose attached client left is cancelled (Tom, 2026-10-21);
 * - durable, idempotent `report` facts keyed by `factId`.
 *
 * A run launched here is executed by a detached supervisor
 * (`bin/queue-host-run-supervisor.mjs`) that survives a Queue service roll and
 * writes the durable `host.run.result` record beside the run. The endpoint
 * reattaches every unsettled run to that record on startup, so a roll never
 * strands a run and never relaunches a command blindly.
 *
 * The protocol is not the Queue service protocol (Spec 013): it is a second,
 * host-run-specific socket. `caller` attributes a run; it does not authenticate
 * it. Trust is the host uid.
 */
import {
  spawn,
} from "node:child_process";
import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import {
  type Socket,
} from "node:net";
import {
  join,
} from "node:path";
import {
  fileURLToPath,
} from "node:url";
import {
  type HostRunInternalRecord,
} from "../../shared/contracts";
import {
  HostRunFront,
} from "../executor/host-run-front";
import {
  type HostRunOutputFailureSummary,
} from "../../core/host-runs/host-run-output-failures";
import {
  hostRunSocketPath,
} from "../../core/host-runs/host-run-paths";
import {
  redactHostRunData,
} from "../../core/host-runs/host-run-redact";
import type { HostRunScheduler,HostRunSubmission } from "../../core/host-runs/host-run-scheduler";
import {
  processGroupEmpty,
  signalProcessGroupByLeader,
} from "../../core/machine/process-group";

export { HOST_RUN_CLIENT_PROTOCOL_VERSION, HOST_RUN_MAX_REQUEST_BYTES, HOST_RUN_OUTPUT_CHUNK_BYTES, HOST_RUN_OUTPUT_RETENTION_MS, HOST_RUN_RECONNECT_WINDOW_MS, HOST_RUN_UNLAUNCHED_GRACE_MS, HOST_RUN_CLIENT_LEFT_REASON, HOST_RUN_TERMINATION_GRACE_MS, HOST_RUN_TOKEN_GRACE_MS, HOST_RUN_ATTACH_POLL_MS, HOST_RUN_SUPERVISOR_POLL_MS, HOST_RUN_SUPERVISOR_STATE_GRACE_MS, HOST_RUN_FACT_CACHE_BYTES, HostRunRetainedStream, HostRunSupervisorSpawn, HostRunClientErrorCode } from "../../core/host-runs/host-run-endpoint-types";
/** Spawn the detached supervisor that outlives a Queue service roll. */
function defaultSupervisorSpawn(plan: HostRunSupervisorPlan): void {
  const entry = fileURLToPath(new URL("../../bin/queue-host-run-supervisor.mjs", import.meta.url));
  const sourcePath = fileURLToPath(new URL("../..", import.meta.url));
  const child = spawn(process.execPath, [...runtimeNodeArgs(), entry, plan.stateDir, plan.runId], {
    detached: true, stdio: "ignore", env: { ...process.env }, cwd: sourcePath,
  });
  child.on("error", () => { /* no result means the run settles lost; it is never relaunched blindly */ });
  child.unref();
  if (!child.pid) throw new Error("Nucleus could not start the detached host-run supervisor");
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

export interface HostRunEndpointOptions {
  stateDir?: string;
  socketPath?: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  reconnectWindowMs?: number;
  unlaunchedGraceMs?: number;
  outputRetentionMs?: number;
  terminationGraceMs?: number;
  tokenGraceMs?: number;
  maxRequestBytes?: number;
  /** Test seam: replaces the detached supervisor with a fake that writes the same files. */
  supervisorSpawn?: HostRunSupervisorSpawn;
  /** Test seam: supervisor record/result poll cadence. */
  supervisorPollMs?: number;
  /** Test seam: maintenance cadence, whose retention sweep is one bounded page per pass. */
  maintenanceIntervalMs?: number;
  /** Adopt the front a warm standby already started, or start a dedicated front. */
  front?: HostRunFront | "start";
}

export class HostRunEndpoint {
  private readonly attach: HostRunAttach;

  private readonly watch: HostRunWatch;

  private readonly retention: HostRunRetention;

  private readonly servingOwner: HostRunServing;

  readonly stateDir: string;
  readonly socketPath: string;
  private readonly nowMs: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly reconnectWindowMs: number;
  private readonly unlaunchedGraceMs: number;
  private readonly outputRetentionMs: number;
  private readonly terminationGraceMs: number;
  private readonly tokenGraceMs: number;
  private readonly maxRequestBytes: number;
  private readonly supervisorSpawn: HostRunSupervisorSpawn;
  private readonly supervisorPollMs: number;
  private readonly maintenanceIntervalMs: number;
  private keys: HostRunTokenKeys | null = null;
  private readonly facts = new Map<string, { body: string; fact: unknown }>();
  private factCacheBytes = 0;
  private authorityError: string | null = null;
  private readonly sockets = new Set<Socket>();
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(readonly scheduler: HostRunScheduler, options: HostRunEndpointOptions = {}) {
    this.stateDir = options.stateDir ?? defaultHostRunStateDir(options.env ?? process.env);
    this.socketPath = options.socketPath ?? hostRunSocketPath(this.stateDir);
    this.nowMs = options.now ?? Date.now;
    this.env = options.env ?? process.env;
    this.reconnectWindowMs = options.reconnectWindowMs ?? HOST_RUN_RECONNECT_WINDOW_MS;
    this.unlaunchedGraceMs = options.unlaunchedGraceMs ?? HOST_RUN_UNLAUNCHED_GRACE_MS;
    this.outputRetentionMs = options.outputRetentionMs ?? HOST_RUN_OUTPUT_RETENTION_MS;
    this.terminationGraceMs = options.terminationGraceMs ?? HOST_RUN_TERMINATION_GRACE_MS;
    this.tokenGraceMs = options.tokenGraceMs ?? HOST_RUN_TOKEN_GRACE_MS;
    this.maxRequestBytes = options.maxRequestBytes ?? HOST_RUN_MAX_REQUEST_BYTES;
    this.supervisorSpawn = options.supervisorSpawn ?? defaultSupervisorSpawn;
    this.supervisorPollMs = options.supervisorPollMs ?? HOST_RUN_SUPERVISOR_POLL_MS;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 30_000;
    const endpoint = this;
    this.servingOwner = new HostRunServing({
      get scheduler() { return endpoint.scheduler; },
      get socketPath() { return endpoint.socketPath; },
      get stateDir() { return endpoint.stateDir; },
      get nowMs() { return endpoint.nowMs; },
      get stopping() { return endpoint.stopping; },
      onConnection: (...args) => this.onConnection(...args),
    }, typeof options.front === "object" ? options.front : undefined);
    this.retention = new HostRunRetention({
      get scheduler() { return endpoint.scheduler; },
      get nowMs() { return endpoint.nowMs; },
      get outputRetentionMs() { return endpoint.outputRetentionMs; },
      get stateDir() { return endpoint.stateDir; },
    });
    this.watch = new HostRunWatch({
      get stopping() { return endpoint.stopping; },
      get supervisorPollMs() { return endpoint.supervisorPollMs; },
      get scheduler() { return endpoint.scheduler; },
      get nowMs() { return endpoint.nowMs; },
      get stateDir() { return endpoint.stateDir; },
    });
    this.attach = new HostRunAttach({
      get scheduler() { return endpoint.scheduler; },
      writeResponse: (...args) => this.writeResponse(...args),
      failure: (...args) => this.failure(...args),
      retainedFrom: (...args) => this.retention.retainedFrom(...args),
      get stateDir() { return endpoint.stateDir; },
      readOutputRetention: (...args) => this.retention.readOutputRetention(...args),
      readSupervisorState: (...args) => this.watch.readSupervisorState(...args),
      readSubmission: (...args) => this.readSubmission(...args),
      get reconnectWindowMs() { return endpoint.reconnectWindowMs; },
      get unlaunchedGraceMs() { return endpoint.unlaunchedGraceMs; },
      get nowMs() { return endpoint.nowMs; },
      cancelRun: (...args) => this.cancelRun(...args),
    });
  }

  /** Publish the authority file, serve the socket and reattach every unsettled run. */
  async start(): Promise<void> {
    this.ensureState();
    this.syncTokenKeys();
    this.loadFacts();
    this.reconcileFacts();
    this.compactFacts();
    const serving = await this.ensureServing();
    this.startMaintenance();
    if (!serving || !this.servingOwner.serving()) throw new Error(this.servingOwner.serveError ?? `Host-run socket did not bind: ${this.socketPath}`);
    this.servingOwner.serveError = null;
    try { this.reconcileSubmissions(); } catch (error) { console.error("Host-run endpoint reattach failed:", error instanceof Error ? error.message : String(error)); }
  }

  /** Why this endpoint is not serving the socket; null while it serves. */
  error(): string | null { return this.authorityError ?? (this.servingOwner.serving() ? null : this.servingOwner.serveError); }

  /**
   * Bind the contract-010 socket when this process has none, or rebind one whose
   * path was lost (Spec 035, "Endpoint across a roll"). 2026-10-04: a roll that
   * handed the endpoint away and fell back left the process serving
   * `queue-service.sock` with no host-run endpoint, and every heavy run failed
   * closed machine-wide until an operator restart.
   *
   * A live holder is never taken over: the socket path must not answer, and
   * `authority.json` must not name a live pid whose start identity still matches
   * (contract 010's pid-plus-start-identity rule). Contract 010's file checks are
   * the same ones `listen` and `writeAuthority` already apply. Returns true when
   * this endpoint serves the socket after the call; otherwise `error()` says why.
   */
  async ensureServing(): Promise<boolean> {
    if (this.stopping) return false;
    // Arm the retry now, so a refused or failed bind is retried even when this
    // endpoint's caller keeps no timer of its own (a roll fallback that resumed
    // a process, or a fixture runtime).
    this.startMaintenance();
    return this.servingOwner.ensureServingThroughFront();
  }

  private startMaintenance(): void {
    if (this.maintenanceTimer || this.stopping) return;
    this.maintenanceTimer = setInterval(() => this.maintenance(), this.maintenanceIntervalMs);
    this.maintenanceTimer.unref?.();
  }

  /** Close the socket and drop attachments. Authority is left in place for the next holder. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    // A roll must not lose an interactive client's disconnect window: persist
    // one durable deadline per attached cancelOnDisconnect run before the
    // sockets close, whichever number of attachments it has, so the
    // replacement endpoint honours the remaining window.
    const affected = new Map<string, "cancel" | "unlaunched">();
    for (const attachment of this.attach.attachments) {
      const run = this.scheduler.get(attachment.runId);
      if (!run || run.state === "settled") continue;
      const mode = this.attach.disconnectModeFor(run);
      if (mode) affected.set(attachment.runId, mode);
    }
    for (const [runId, mode] of affected) {
      if (existsSync(hostRunSupervisorPaths(this.stateDir, runId).disconnectPath)) continue;
      this.attach.persistDisconnectDeadline(runId, this.nowMs() + this.attach.windowFor(mode), mode);
    }
    for (const timer of this.attach.disconnectTimers.values()) clearTimeout(timer);
    this.attach.disconnectTimers.clear();
    for (const timer of this.watch.watches.values()) clearInterval(timer);
    this.watch.watches.clear();
    for (const attachment of this.attach.attachments) { clearInterval(attachment.timer); attachment.socket.destroy(); }
    this.attach.attachments.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.servingOwner.server;
    this.servingOwner.server = null;
    if (server) await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    if (server) this.scheduler.recordEndpointEvent("endpoint_unbound");
    // The front worker owns the public listener: stop it before this endpoint
    // removes anything, so no fresh accept lands on a socket we are closing.
    const front = this.servingOwner.front;
    if (front) await front.stop();
    this.servingOwner.removeSocketVerified();
    this.servingOwner.removeInnerSocketVerified();
  }

  private ensureState(): void {
    const root = this.ensureStateRoot();
    ensureVerifiedDirectoryChain(root, ["run"]);
    ensureVerifiedDirectoryChain(root, ["runs"]);
  }

  /** Create the owned root once and resolve it; a symlinked final component refuses. */
  private ensureStateRoot(): string {
    let info: Stats | null = null;
    try { info = lstatSync(this.stateDir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!info) { mkdirSync(this.stateDir, { recursive: true, mode: 0o700 }); info = lstatSync(this.stateDir); }
    if (info.isSymbolicLink()) throw new Error(`Host-run state root is a symlink: ${this.stateDir}`);
    if (!info.isDirectory()) throw new Error(`Host-run state root is not a directory: ${this.stateDir}`);
    const root = realpathSync(this.stateDir);
    ensureVerifiedDirectoryChain(root, []);
    return root;
  }

  /**
   * The token key rotates only when the authority epoch advances (contract 010,
   * Run token). A restart at the same epoch reuses the persisted keys, so
   * already-launched tokens and the previous-epoch key survive a service roll.
   */
  private syncTokenKeys(): void {
    const epoch = this.scheduler.authority().epoch;
    if (this.keys && this.keys.current.epoch === epoch) return;
    const persisted = readHostRunTokenKeys(this.stateDir);
    if (persisted && persisted.current.epoch === epoch) { this.keys = persisted; return; }
    const source = persisted?.current ?? (this.keys ? { epoch: this.keys.current.epoch, keyB64: this.keys.current.keyB64 } : undefined);
    const previous = source ? { epoch: source.epoch, keyB64: source.keyB64 } : undefined;
    const keys: HostRunTokenKeys = { format: HOST_RUN_KEYS_FORMAT, version: 1, current: { epoch, keyB64: randomBytes(32).toString("base64") }, ...(previous ? { previous } : {}) };
    writeVerifiedOwnedFile(this.stateDir, ["token.key"], JSON.stringify(keys), 0o600);
    this.keys = keys;
  }

  private loadFacts(): void {
    let fd: number | null = null;
    try {
      fd = openVerifiedOwnedFile(this.stateDir, ["facts.jsonl"], constants.O_RDONLY, 0o600);
      const size = fstatSync(fd).size;
      const offset = Math.max(0, size - HOST_RUN_FACT_CACHE_BYTES);
      const buffer = Buffer.alloc(Math.min(size, HOST_RUN_FACT_CACHE_BYTES));
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
      // The first line may be partial; its durable copy is in the journal.
      if (offset) lines.shift();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.cacheFact(hostRunFactSchema.parse(JSON.parse(line))); }
        catch { /* one corrupt line cannot hide the rest */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { if (fd !== null) closeSync(fd); }
  }

  private cacheFact(fact: HostRunFact): void {
    const body = stableJson(fact);
    const previous = this.facts.get(fact.factId);
    if (previous) this.factCacheBytes -= Buffer.byteLength(previous.body) + 1;
    this.facts.delete(fact.factId);
    this.facts.set(fact.factId, { body, fact });
    this.factCacheBytes += Buffer.byteLength(body) + 1;
    while (this.factCacheBytes > HOST_RUN_FACT_CACHE_BYTES || this.facts.size > HOST_RUN_FACT_CACHE_ENTRIES) {
      const oldest = this.facts.keys().next().value!;
      this.factCacheBytes -= Buffer.byteLength(this.facts.get(oldest)!.body) + 1;
      this.facts.delete(oldest);
    }
  }

  private compactFacts(): void {
    writeVerifiedOwnedFile(this.stateDir, ["facts.jsonl"],
      [...this.facts.values()].map(entry => entry.body + "\n").join(""), 0o600);
  }

  /**
   * A durable non-container fact is written before its event. If the process
   * exited in that gap, the fact is reloaded here and its journal event is
   * recreated, so a retry that is acked does not leave the journal short.
   */
  private reconcileFacts(): void {
    for (const { fact } of this.facts.values()) {
      const parsed = fact as { kind?: unknown; factId?: unknown };
      if (parsed.kind === "nested" || parsed.kind === "override") {
        try { this.journalFact(hostRunFactSchema.parse(fact)); } catch { /* a corrupt fact is skipped */ }
      }
    }
  }

  private maintenance(): void {
    if (this.stopping) return;
    // Bind first: a lost path (or an endpoint that never bound) is the failure
    // that makes every heavy client fail closed. Never publish authority while a
    // foreign holder may have taken the path.
    void this.ensureServing();
    if (!this.servingOwner.serving()) return;
    try {
      this.syncTokenKeys();
      this.servingOwner.writeAuthority();
      this.authorityError = null;
    } catch (error) {
      const message = `Host-run authority publication failed: ${errorText(error)}`;
      if (this.authorityError !== message) console.error(message);
      this.authorityError = message;
    }
    try { this.retention.sweepRetainedOutput(); } catch { /* retried next pass */ }
  }

  // -- requests -------------------------------------------------------------

  private onConnection(socket: Socket): void {
    if (!this.servingOwner.answeredSinceBind) {
      this.servingOwner.answeredSinceBind = true;
      this.scheduler.recordEndpointEvent("endpoint_answered");
    }
    this.sockets.add(socket);
    let buffer: Buffer = Buffer.alloc(0);
    let failed = false;
    socket.on("data", (chunk: Buffer) => {
      if (failed) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (!failed) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          if (buffer.length > this.maxRequestBytes) { this.writeResponse(socket, this.failure("", "invalid", "Request line exceeds 1 MiB")); failed = true; socket.destroy(); }
          return;
        }
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > this.maxRequestBytes) { this.writeResponse(socket, this.failure("", "invalid", "Request line exceeds 1 MiB")); failed = true; socket.destroy(); return; }
        this.handleLine(socket, line.toString("utf8"));
      }
    });
    socket.on("error", () => { /* the close handler cleans up attachments */ });
    socket.on("close", () => { this.sockets.delete(socket); this.attach.onSocketClosed(socket); });
  }

  private handleLine(socket: Socket, text: string): void {
    let frame: unknown;
    try { frame = JSON.parse(text); }
    catch { this.writeResponse(socket, this.failure("", "invalid", "Request line is not JSON")); return; }
    if (typeof frame !== "object" || frame === null) { this.writeResponse(socket, this.failure("", "invalid", "Request is not an object")); return; }
    const request = frame as Record<string, unknown>;
    const id = typeof request.id === "string" ? request.id : "";
    if (request.v !== HOST_RUN_CLIENT_PROTOCOL_VERSION) { this.writeResponse(socket, this.failure(id, "unsupported_version", `Unsupported protocol version ${JSON.stringify(request.v)}`)); return; }
    const method = typeof request.method === "string" ? request.method : "";
    const epoch = typeof request.epoch === "number" ? request.epoch : Number.NaN;
    let authorityEpoch: number;
    try { authorityEpoch = this.scheduler.authority().epoch; }
    catch (error) { this.writeResponse(socket, this.failure(id, "stale_epoch", String(error instanceof Error ? error.message : error))); return; }
    if (epoch !== authorityEpoch) { this.writeResponse(socket, this.failure(id, "stale_epoch", `Request epoch ${JSON.stringify(request.epoch)} is not current epoch ${authorityEpoch}`)); return; }
    try {
      switch (method) {
        case "submit": this.writeResponse(socket, this.onSubmit(id, request.body)); return;
        case "cancel": this.writeResponse(socket, this.onCancel(id, request.body)); return;
        case "status": this.writeResponse(socket, this.onStatus(id, request.body)); return;
        case "report": this.writeResponse(socket, this.onReport(id, request.body)); return;
        case "attach": this.attach.onAttach(id, socket, request.body); return;
        default: this.writeResponse(socket, this.failure(id, "invalid", `Unknown method ${JSON.stringify(method)}`)); return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code: HostRunClientErrorCode = message.startsWith("stale_epoch") ? "stale_epoch"
        : message.startsWith("unknown_run") ? "unknown_run"
          : message.startsWith("conflict") ? "conflict" : "invalid";
      this.writeResponse(socket, this.failure(id, code, message));
    }
  }

  private writeResponse(socket: Socket, value: unknown): void {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(value)}\n`);
  }
  private success(id: string, body: unknown) { return { v: 1, id, ok: true, body }; }
  private failure(id: string, code: HostRunClientErrorCode, message: string) { return { v: 1, id, ok: false, error: { code, message } }; }

  // -- submit ---------------------------------------------------------------

  private onSubmit(id: string, body: unknown) {
    const parsed = hostRunSubmitBodySchema.safeParse(body);
    if (!parsed.success) return this.failure(id, "invalid", parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    const submission = parsed.data;
    const runId = this.runIdFor(submission.caller, submission.clientRequestId);
    const existing = this.readSubmission(runId);
    if (existing) {
      // Names-only comparison: values are not retained, so a retry that changes only a value is the same submission.
      if (stableJson(existing.body) !== stableJson(storedBodyOf(submission))) return this.failure(id, "conflict", `clientRequestId ${submission.clientRequestId} already names a different submission`);
      const run = this.ensureSubmitted(existing);
      // A retry re-supplies the ephemeral env a roll or crash may have lost, while the run is unlaunched.
      if ((run.state === "queued" || run.state === "admitted") && !readHostRunLaunchEnv(this.stateDir, runId)) writeHostRunLaunchEnv(this.stateDir, runId, submission.env);
      return this.success(id, { runId, state: run.state === "queued" ? "queued" : "admitted", ...(run.position != null ? { position: run.position } : {}) });
    }
    const epoch = this.scheduler.authority().epoch;
    const emittedAt = new Date(this.nowMs()).toISOString();
    const stored: StoredSubmission = {
      runId, caller: submission.caller, clientRequestId: submission.clientRequestId, submittedAt: emittedAt, epoch,
      cancelOnDisconnect: submission.cancelOnDisconnect ?? submission.priority === "interactive", body: storedBodyOf(submission),
    };
    writeHostRunLaunchEnv(this.stateDir, runId, submission.env);
    this.writeSubmission(stored);
    let record: HostRunInternalRecord;
    try {
      record = this.scheduler.submit(this.schedulerInput(stored), this.handlerFor(stored));
    } catch (error) {
      // A fenced submission created no run; the durable key is repaired at the
      // next submit/status/startup, never dropped.
      throw error;
    }
    // scheduler.submit already published the `host.run.submit` request (contract 009); a
    // second client-named request was outside the pinned stream kinds (nucleus#074, 2026-10-03).
    this.watch.watchRun(runId);
    return this.success(id, { runId, state: record.state === "queued" ? "queued" : "admitted", ...(record.position != null ? { position: record.position } : {}) });
  }

  /**
   * Idempotency repair. A crash between `submission.json` and the scheduler row
   * leaves a durable key without a run; submitting the stored body recreates it,
   * so a permitted retry never returns a synthetic state and never double-runs.
   */
  private ensureSubmitted(stored: StoredSubmission): HostRunInternalRecord {
    const existing = this.scheduler.get(stored.runId);
    if (existing) return existing;
    const run = this.scheduler.submit(this.schedulerInput(stored), this.handlerFor(stored));
    this.watch.watchRun(stored.runId);
    return run;
  }

  private schedulerInput(stored: StoredSubmission): HostRunSubmission {
    const body = stored.body;
    return {
      id: stored.runId, epoch: stored.epoch, submissionSource: "client", caller: body.caller,
      repository: { origin: body.repository, path: body.cwd }, selector: body.selector,
      runClass: body.class, classSource: body.classSource, priority: body.priority,
      runTimeoutMs: body.runTimeoutMs, capacityDeadlineMs: body.capacityDeadlineMs,
      budgetFallback: body.budgetFallback, submittedAt: stored.submittedAt,
    };
  }

  private handlerFor(stored: StoredSubmission) {
    return {
      launch: (run: HostRunInternalRecord) => this.launch(run, stored),
      terminal: (run: HostRunInternalRecord) => this.onTerminal(run),
    };
  }

  private launch(run: HostRunInternalRecord, stored: StoredSubmission): void {
    // Recovery guard: a durable result means this run already executed. Settle
    // from it and never spawn a second supervisor, so a resubmitted or
    // reconstructed row cannot duplicate work that has already finished.
    const durableResult = this.watch.readSupervisorResult(run.id);
    if (durableResult) {
      // Never settle, release, or relaunch over a live process group or a
      // possibly-live escaped descendant. An unreadable escapee identity is
      // unknown, not dead: keep the run watched and let the async watch prove
      // absence (a missing PID entry or kernel ESRCH) before settling.
      if ((durableResult.pgid && !processGroupEmpty(durableResult.pgid)) || this.watch.escapedDescendantNeedsWatch(durableResult)) { this.watch.watchRun(run.id); return; }
      this.watch.settleFromResult(run, durableResult, this.watch.readSupervisorState(run.id));
      return;
    }
    const listedEnv = readHostRunLaunchEnv(this.stateDir, run.id);
    if (!listedEnv) {
      // Never launch with a guessed env: the values are not retained anywhere else.
      this.scheduler.rejectBeforeLaunch(run.id, "The ephemeral launch env for this run is missing (a service roll or cleanup removed it); resubmit the run");
      return;
    }
    const launched = this.scheduler.markLaunched(run.id);
    if (launched.state !== "running" || !launched.launchedAt) return;
    const paths = hostRunSupervisorPaths(this.stateDir, launched.id);
    const token = this.tokenForRun(launched, stored);
    const launchEnv = hostRunLaunchEnvironment(listedEnv, { runId: launched.id, token, env: this.env });
    writeHostRunLaunchEnv(this.stateDir, launched.id, launchEnv);
    const plan: HostRunSupervisorPlan = {
      format: HOST_RUN_SUPERVISOR_PLAN_FORMAT, version: 1, stateDir: this.stateDir,
      runId: launched.id, epoch: launched.epoch, argv: stored.body.argv, cwd: stored.body.cwd,
      envKeys: Object.keys(launchEnv).sort(),
      runTimeoutMs: launched.runTimeoutMs, graceMs: this.terminationGraceMs,
      startedAt: launched.launchedAt,
    };
    writeVerifiedOwnedFile(this.stateDir, ["runs", launched.id, "supervisor.plan.json"], JSON.stringify(hostRunSupervisorPlanSchema.parse(plan)), 0o600);
    this.supervisorSpawn(plan);
    this.watch.watchRun(launched.id);
  }

  private tokenForRun(run: HostRunInternalRecord, stored: StoredSubmission): string {
    this.syncTokenKeys();
    const keys = this.keys!;
    const root = realpathSync(stored.body.cwd);
    const launchedAt = Date.parse(run.launchedAt ?? new Date(this.nowMs()).toISOString());
    return signRunToken({
      runId: run.id, epoch: run.epoch, class: stored.body.class, root,
      exp: launchedAt + run.runTimeoutMs + this.tokenGraceMs,
    }, keys.current.keyB64);
  }

  private onTerminal(run: HostRunInternalRecord): void {
    this.watch.stopWatch(run.id);
    this.attach.clearDisconnectDeadline(run.id);
    removeHostRunLaunchEnv(this.stateDir, run.id);
  }

  // -- restart recovery -----------------------------------------------------

  /**
   * Contract 010 restart recovery: every durable submission with an unsettled
   * run is reattached. Queued and admitted runs get their handler back and are
   * admitted normally; running runs are observed through the supervisor record
   * and the durable result, and settle `lost` only once the process group is
   * proven dead with no result.
   */
  private reconcileSubmissions(): void {
    for (const runId of this.listSubmissionRunIds()) {
      const stored = this.readSubmission(runId);
      if (!stored) continue;
      let run = this.scheduler.get(runId);
      if (!run) {
        try { run = this.ensureSubmitted(stored); }
        catch { continue; }
      }
      if (run.state === "settled") continue;
      // A disconnect deadline that expired while no endpoint ran is honoured
      // first: attaching restores the launch handler, and the run could start
      // for a client that is gone (Sol, #577).
      this.attach.recoverDisconnect(runId);
      run = this.scheduler.get(runId);
      if (!run || run.state === "settled") continue;
      if (run.state === "queued" || run.state === "admitted") {
        try { this.scheduler.attach(runId, this.handlerFor(stored)); } catch { /* stale epoch: a later owner reconciles */ }
      }
      this.watch.watchRun(runId);
    }
  }

  private listSubmissionRunIds(): string[] {
    try {
      const root = realpathSync(this.stateDir);
      const runsDir = join(root, "runs");
      return readdirSync(runsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch { return []; }
  }

  // -- cancel ---------------------------------------------------------------

  private onCancel(id: string, body: unknown) {
    const parsed = hostRunCancelBodySchema.safeParse(body);
    if (!parsed.success) return this.failure(id, "invalid", parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    const run = this.scheduler.get(parsed.data.runId);
    if (!run) return this.failure(id, "unknown_run", `No host run ${parsed.data.runId}`);
    if (run.state === "settled") return this.success(id, { runId: run.id, state: run.state });
    const current = this.cancelRun(run.id, parsed.data.reason);
    if (!current) return this.failure(id, "not_permitted", "The run has no recorded process group and cannot be stopped");
    return this.success(id, { runId: run.id, state: current.state });
  }

  private cancelRun(runId: string, reason: string): HostRunInternalRecord | null {
    const run = this.scheduler.get(runId);
    if (!run || run.state === "settled") return run;
    if (run.state === "queued" || run.state === "admitted") {
      try { return this.scheduler.cancelQueued(runId, reason, run.epoch); }
      catch { return this.scheduler.get(runId); }
    }
    // A running cancel publishes the contract's `host.run.cancel` request; queued and
    // admitted runs get theirs from cancelQueued.
    if (this.readSubmission(runId) || (run.processGroupId && run.startIdentity))
      this.scheduler.note(runId, "request", { method: "host.run.cancel", input: { runId, reason } });
    // A run this endpoint launched is stopped through its supervisor's durable
    // cancel request, so a Queue roll cannot lose the stop.
    if (this.readSubmission(runId)) {
      this.writeCancelRequest(runId, reason);
      this.watch.watchRun(runId);
      return run;
    }
    if (run.processGroupId && run.pid && run.startIdentity) {
      return signalProcessGroupByLeader(run.processGroupId, run.pid, run.startIdentity, "SIGTERM") ? run : null;
    }
    return null;
  }

  private writeCancelRequest(runId: string, reason: string): void {
    const paths = hostRunSupervisorPaths(this.stateDir, runId);
    writeVerifiedOwnedFile(this.stateDir, ["runs", runId, "cancel.json"], JSON.stringify(hostRunCancelRequestSchema.parse({
      format: "host.run.cancel", version: 1, runId, reason, requestedAt: new Date(this.nowMs()).toISOString(),
    })), 0o600);
  }

  // -- status ---------------------------------------------------------------

  private onStatus(id: string, body: unknown) {
    const parsed = hostRunStatusBodySchema.safeParse(body ?? {});
    if (!parsed.success) return this.failure(id, "invalid", parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    const query = parsed.data;
    if (query.runId) return this.statusForRun(id, query.runId);
    if (query.caller && query.clientRequestId) {
      const runId = this.runIdFor(query.caller, query.clientRequestId);
      const stored = this.readSubmission(runId);
      if (!stored) return this.failure(id, "unknown_run", `No submission for ${query.caller}/${query.clientRequestId}`);
      const run = this.ensureSubmitted(stored);
      return this.statusForRun(id, run.id);
    }
    if (!query.runId && !query.caller && !query.clientRequestId) {
      const summary = this.scheduler.summary();
      return this.success(id, {
        budget: {
          sampledAt: summary.sampledAt, cpuCapacity: summary.cpuCapacity, memoryCapacityBytes: summary.memoryCapacityBytes,
          reservedCpu: summary.reservedCpu, reservedMemoryBytes: summary.reservedMemoryBytes,
          freeMemoryBytes: summary.freeMemoryBytes, loadAverage: summary.loadAverage,
        },
        running: summary.running, admitted: summary.admitted, queued: summary.queued,
      });
    }
    return this.failure(id, "invalid", "status takes { runId }, { caller, clientRequestId } or {}");
  }

  private statusForRun(id: string, runId: string) {
    const run = this.scheduler.get(runId);
    if (!run) return this.failure(id, "unknown_run", `No host run ${runId}`);
    return this.success(id, this.runView(run));
  }

  private runView(run: HostRunInternalRecord) {
    return {
      runId: run.id, state: run.state, position: run.position ?? null, epoch: run.epoch,
      caller: run.caller, repository: run.repository, selector: run.selector,
      runClass: run.runClass, classSource: run.classSource, priority: run.priority,
      submittedAt: run.submittedAt, capacityDeadlineAt: run.capacityDeadlineAt, runTimeoutMs: run.runTimeoutMs,
      admittedAt: run.admittedAt ?? null, launchedAt: run.launchedAt ?? null, settledAt: run.settledAt ?? null,
      pgid: run.processGroupId ?? null, pid: run.pid ?? null, startIdentity: run.startIdentity ?? null,
      wallMs: run.wallMs ?? null, cpuMs: run.cpuMs ?? null, containers: run.containers,
      settlement: run.settlement ?? null,
    };
  }

  // -- report ---------------------------------------------------------------

  private onReport(id: string, body: unknown) {
    const parsed = hostRunReportBodySchema.safeParse(body);
    if (!parsed.success) return this.failure(id, "invalid", parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    const facts = parsed.data.facts;
    // Dedup and conflict checks happen before any durable write, including a
    // duplicate factId inside this same batch and a retry that arrives after a
    // crash gap between the durable journal write and the fact log.
    const batch = new Map<string, string>();
    for (const fact of facts) {
      const encoded = stableJson(fact);
      const inBatch = batch.get(fact.factId);
      if (inBatch !== undefined && inBatch !== encoded) return this.failure(id, "conflict", `factId ${fact.factId} appears twice with different bodies`);
      batch.set(fact.factId, encoded);
      const known = this.facts.get(fact.factId);
      if (known && known.body !== encoded) return this.failure(id, "conflict", `factId ${fact.factId} already names a different body`);
      const durable = this.durableFact(fact);
      if (durable && stableJson(durable) !== encoded) return this.failure(id, "conflict", `factId ${fact.factId} already names a different journaled body`);
    }
    const acked: unknown[] = [];
    for (const fact of facts) {
      const known = this.facts.get(fact.factId);
      if (known) { acked.push(known.fact); continue; }
      const durable = this.durableFact(fact);
      if (durable) {
        // The durable write already happened; only the fact log is short. Repair
        // it, never re-journal or re-report capacity, and ack the stored copy.
        this.storeFact(fact);
        acked.push(durable);
        continue;
      }
      if (fact.kind === "container") {
        if (fact.removed === undefined && fact.event === "removed") return this.failure(id, "invalid", `factId ${fact.factId}: removed events require removed`);
        this.scheduler.reportContainerFact({
          factId: fact.factId, observedAt: fact.observedAt, runId: fact.runId, epoch: fact.epoch,
          runtime: fact.runtime, containerId: fact.containerId, event: fact.event,
          ...(fact.removed !== undefined ? { removed: fact.removed } : {}),
        });
        this.storeFact(fact);
      } else {
        this.journalFact(fact);
        this.storeFact(fact);
      }
      acked.push(fact);
    }
    return this.success(id, { facts: acked });
  }

  /**
   * The durable journal body for a fact, across every report fact kind, so a
   * reused `factId` is a global `conflict` even after a crash gap between the
   * journal write and the fact log. A non-container row carries a synthetic
   * holder `runId` that is not part of the fact; a container row carries the run
   * the container belongs to and omits the `kind` discriminator.
   */
  private durableFact(fact: HostRunFact): unknown | null {
    const row = this.scheduler.store.db.prepare(
      "SELECT event,data FROM host_run_journal WHERE event IN ('nested','override','container_report') AND json_extract(data,'$.factId')=? ORDER BY id LIMIT 1",
    ).get(fact.factId) as { event: string; data: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.data) as Record<string, unknown>;
      if (row.event === "container_report") return { kind: "container", ...parsed };
      const { runId: _runId, ...stored } = parsed;
      return stored;
    } catch { return null; }
  }

  /** Journal a non-container fact once, refusing a different body for the same id. */
  private journalFact(fact: HostRunFact): void {
    const durable = this.durableFact(fact);
    if (durable) {
      if (stableJson(durable) !== stableJson(fact)) throw new Error(`conflict: host-run fact ${fact.factId} changed body`);
      return;
    }
    const holder = fact.kind === "nested" ? fact.parentRunId : "host-run-override";
    this.scheduler.note(holder, fact.kind, { ...fact });
  }

  private storeFact(fact: HostRunFact): void {
    appendVerifiedOwnedFile(this.stateDir, ["facts.jsonl"], `${JSON.stringify(fact)}\n`);
    this.cacheFact(fact);
    // Appends may temporarily exceed the cap by one request, then compact.
    if (statSync(join(this.stateDir, "facts.jsonl")).size > HOST_RUN_FACT_CACHE_BYTES) this.compactFacts();
  }

  // -- output ---------------------------------------------------------------

  private outputPath(runId: string, stream: "stdout" | "stderr"): string {
    return hostRunSupervisorPaths(this.stateDir, runId)[stream === "stdout" ? "stdoutPath" : "stderrPath"];
  }

  // -- durable submission records ------------------------------------------

  private runIdFor(caller: string, clientRequestId: string): string {
    return createHash("sha256").update(`${caller}\u0000${clientRequestId}`).digest("hex");
  }

  private readSubmission(runId: string): StoredSubmission | null {
    const raw = readCheckedHostRunFile(this.stateDir, ["runs", runId, "submission.json"]);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as { stored?: unknown };
      const body = storedBodySchema.parse(redactHostRunData((parsed.stored as { body?: unknown })?.body));
      const stored = parsed.stored as StoredSubmission;
      return { ...stored, body };
    } catch { return null; }
  }

  private writeSubmission(stored: StoredSubmission): void {
    writeVerifiedOwnedFile(this.stateDir, ["runs", stored.runId, "submission.json"], JSON.stringify(redactHostRunData({ format: "host.run.submission", version: 1, stored })), 0o600);
  }

  heavyFollowerCount(): number { return this.attach.heavyFollowerCount(); }

  sweepRetainedOutput(): void { return this.retention.sweepRetainedOutput(); }

  retentionFailureSummary(): HostRunOutputFailureSummary { return this.retention.retentionFailureSummary(); }

  retentionError(): string { return this.retention.retentionError(); }

  rebindIfLost(): Promise<boolean> { return this.servingOwner.rebindIfLost(); }

  serving(): boolean { return this.servingOwner.serving(); }
}

/** Re-export so callers and tests can name the durable fact shapes. */
export type { HostRunFact as HostRunReportedFact };
