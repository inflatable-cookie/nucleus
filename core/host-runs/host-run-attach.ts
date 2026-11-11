import {
  closeSync,
  constants,
  fstatSync,
  readSync,
  rmSync,
} from "node:fs";
import {
  type Socket,
} from "node:net";
import {
  type HostRunInternalRecord,
} from "../../shared/contracts";
import {
  Attachment,
  HOST_RUN_ATTACH_POLL_MS,
  HOST_RUN_CLIENT_LEFT_REASON,
  HOST_RUN_OUTPUT_CHUNK_BYTES,
  HostRunClientErrorCode,
  StoredSubmission,
  neverLaunched,
} from "./host-run-endpoint-types";
import {
  hostRunSupervisorPaths,
  openVerifiedOwnedFile,
  readCheckedHostRunFile,
  writeVerifiedOwnedFile,
} from "./host-run-files";
import type { HostRunScheduler } from "./host-run-scheduler";
import {
  hostRunAttachBodySchema,
  hostRunDisconnectSchema,
  type HostRunOutputRetention,
  type HostRunSupervisorState,
} from "./host-run-wire";

interface HostRunAttachContext {
  scheduler: HostRunScheduler;
  writeResponse: (socket: Socket, value: unknown) => void;
  failure: (id: string, code: HostRunClientErrorCode, message: string) => { v: number; id: string; ok: boolean; error: { code: HostRunClientErrorCode; message: string; }; };
  retainedFrom: (run: HostRunInternalRecord, stream: "stdout" | "stderr") => number;
  stateDir: string;
  readOutputRetention: (runId: string) => HostRunOutputRetention | null;
  readSupervisorState: (runId: string) => HostRunSupervisorState | null;
  readSubmission: (runId: string) => StoredSubmission | null;
  reconnectWindowMs: number;
  unlaunchedGraceMs: number;
  nowMs: () => number;
  cancelRun: (runId: string, reason: string) => HostRunInternalRecord | null;
}

export class HostRunAttach {
  constructor(private readonly context: HostRunAttachContext) {}

  /**
   * Unsettled heavy runs with a live attach follower. The bridge defers a source
   * roll while this is greater than zero, until the run settles or the cap elapses.
   */
  heavyFollowerCount(): number {
    let count = 0;
    for (const attachment of this.attachments) {
      const run = this.context.scheduler.get(attachment.runId);
      if (run && run.state !== "settled" && run.runClass === "heavy") count++;
    }
    return count;
  }

  // -- attach ---------------------------------------------------------------

  onAttach(id: string, socket: Socket, body: unknown): void {
    const parsed = hostRunAttachBodySchema.safeParse(body);
    if (!parsed.success) { this.context.writeResponse(socket, this.context.failure(id, "invalid", parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "))); return; }
    const run = this.context.scheduler.get(parsed.data.runId);
    if (!run) { this.context.writeResponse(socket, this.context.failure(id, "unknown_run", `No host run ${parsed.data.runId}`)); return; }
    const requested = { stdout: parsed.data.fromOffset?.stdout ?? 0, stderr: parsed.data.fromOffset?.stderr ?? 0 };
    const offsets = { stdout: requested.stdout, stderr: requested.stderr };
    this.context.writeResponse(socket, { event: "state", state: run.state, ...(run.position != null ? { position: run.position } : {}) });
    for (const stream of ["stdout", "stderr"] as const) {
      let availableFrom: number;
      try { availableFrom = this.context.retainedFrom(run, stream); }
      catch { socket.end(); return; } // Unknown expiry sizes cannot be classified as body errors.
      if (offsets[stream] < availableFrom) {
        this.context.writeResponse(socket, { event: "output_expired", stream, availableFrom });
        offsets[stream] = availableFrom;
      }
    }
    const pending = this.disconnectTimers.get(run.id);
    if (pending) { clearTimeout(pending); this.disconnectTimers.delete(run.id); }
    // A reattach inside the reconnect window keeps the run and clears the
    // durable deadline, so the replacement endpoint cannot cancel it later.
    try { rmSync(hostRunSupervisorPaths(this.context.stateDir, run.id).disconnectPath, { force: true }); } catch { /* best effort */ }
    const attachment: Attachment = { runId: run.id, socket, offsets, idlePollMs: HOST_RUN_ATTACH_POLL_MS, timer: setTimeout(() => this.pumpAttachment(attachment), HOST_RUN_ATTACH_POLL_MS) };
    attachment.timer.unref?.();
    this.attachments.add(attachment);
    this.pumpAttachment(attachment);
  }

  pumpAttachment(attachment: Attachment): void {
    clearTimeout(attachment.timer);
    const before = attachment.offsets.stdout + attachment.offsets.stderr;
    const run = this.context.scheduler.get(attachment.runId);
    if (!run) { this.endAttachment(attachment); return; }
    const expired = this.context.readOutputRetention(run.id);
    for (const stream of ["stdout", "stderr"] as const) {
      // A recorded expiry proves exact byte loss. Missing bytes without that
      // marker are uncertainty, never a zero-length stream or a new offset.
      if (expired && attachment.offsets[stream] >= expired.sizes[stream]) continue;
      if (!run.launchedAt) continue;
      const size = this.outputSize(attachment.runId, stream);
      if (size === null) {
        // Launch marks the row before the supervisor creates its stream files.
        if (run.state !== "settled" && !this.context.readSupervisorState(run.id)?.commandPid) { this.scheduleAttachment(attachment, before); return; }
        this.endAttachment(attachment);
        attachment.socket.end(); // Existing client reconnects boundedly, then holds.
        return;
      }
      let offset = attachment.offsets[stream];
      if (run.state === "settled" && offset > size) {
        this.endAttachment(attachment); attachment.socket.end(); return;
      }
      while (offset < size) {
        const length = Math.min(HOST_RUN_OUTPUT_CHUNK_BYTES, size - offset);
        const data = this.readOutput(attachment.runId, stream, offset, length);
        if (!data || data.length !== length) {
          this.endAttachment(attachment);
          attachment.socket.end();
          return; // No settled frame may certify a failed or short retained read.
        }
        this.context.writeResponse(attachment.socket, { event: "output", stream, offset, dataB64: data.toString("base64") });
        offset += data.length;
      }
      attachment.offsets[stream] = offset;
    }
    if (run.state === "settled" && run.settlement) {
      this.context.writeResponse(attachment.socket, { event: "settled", settlement: run.settlement });
      this.endAttachment(attachment);
    }
    if (this.attachments.has(attachment)) this.scheduleAttachment(attachment, before);
  }

  scheduleAttachment(attachment: Attachment, before: number): void {
    attachment.idlePollMs = attachment.offsets.stdout + attachment.offsets.stderr > before
      ? HOST_RUN_ATTACH_POLL_MS : Math.min(500, attachment.idlePollMs * 2);
    attachment.timer = setTimeout(() => this.pumpAttachment(attachment), attachment.idlePollMs);
    attachment.timer.unref?.();
  }

  endAttachment(attachment: Attachment): void {
    clearTimeout(attachment.timer);
    this.attachments.delete(attachment);
  }

  onSocketClosed(socket: Socket): void {
    const closing = [...this.attachments].filter(attachment => attachment.socket === socket);
    for (const attachment of closing) {
      this.endAttachment(attachment);
      const run = this.context.scheduler.get(attachment.runId);
      if (!run || run.state === "settled") continue;
      const mode = this.disconnectModeFor(run);
      if (!mode) continue;
      if ([...this.attachments].some(other => other.runId === attachment.runId)) continue;
      // The deadline is durable, so a service roll cannot lose the window.
      this.scheduleDisconnect(attachment.runId, mode);
    }
  }

  /**
   * What a dropped last attachment means for this run: `cancel` for a
   * `cancelOnDisconnect` submission, `unlaunched` for any other run that has not
   * launched, and nothing for a launched run, which keeps going detached.
   */
  disconnectModeFor(run: HostRunInternalRecord): "cancel" | "unlaunched" | null {
    const stored = this.context.readSubmission(run.id);
    if (!stored) return null; // Only runs submitted through this endpoint have a client to lose.
    if (stored.cancelOnDisconnect) return "cancel";
    return neverLaunched(run) ? "unlaunched" : null;
  }

  windowFor(mode: "cancel" | "unlaunched"): number {
    return mode === "cancel" ? this.context.reconnectWindowMs : this.context.unlaunchedGraceMs;
  }

  disconnectPath(runId: string): string { return hostRunSupervisorPaths(this.context.stateDir, runId).disconnectPath; }

  persistDisconnectDeadline(runId: string, deadlineMs: number, mode: "cancel" | "unlaunched"): void {
    writeVerifiedOwnedFile(this.context.stateDir, ["runs", runId, "disconnect.json"], JSON.stringify(hostRunDisconnectSchema.parse({
      format: "host.run.disconnect", version: 1, runId,
      deadlineAt: new Date(deadlineMs).toISOString(), requestedAt: new Date(this.context.nowMs()).toISOString(),
      ...(mode === "unlaunched" ? { mode } : {}),
    })), 0o600);
  }

  scheduleDisconnect(runId: string, mode: "cancel" | "unlaunched"): void {
    this.persistDisconnectDeadline(runId, this.context.nowMs() + this.windowFor(mode), mode);
    this.armDisconnect(runId, this.windowFor(mode), mode);
  }

  armDisconnect(runId: string, delayMs: number, mode: "cancel" | "unlaunched"): void {
    const existing = this.disconnectTimers.get(runId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => this.fireDisconnect(runId, mode), Math.max(0, delayMs));
    timer.unref?.();
    this.disconnectTimers.set(runId, timer);
  }

  fireDisconnect(runId: string, mode: "cancel" | "unlaunched"): void {
    this.disconnectTimers.delete(runId);
    if ([...this.attachments].some(attachment => attachment.runId === runId)) { this.clearDisconnectDeadline(runId); return; }
    const run = this.context.scheduler.get(runId);
    // An `unlaunched` deadline never stops a run that launched in the meantime.
    if (run && run.state !== "settled" && (mode === "cancel" || neverLaunched(run)))
      this.context.cancelRun(runId, mode === "cancel" ? "attached client disconnected" : HOST_RUN_CLIENT_LEFT_REASON);
    this.clearDisconnectDeadline(runId);
  }

  clearDisconnectDeadline(runId: string): void {
    const timer = this.disconnectTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.disconnectTimers.delete(runId);
    try { rmSync(this.disconnectPath(runId), { force: true }); } catch { /* best effort */ }
  }

  /** Recover a durable disconnect deadline left by a rolled service. */
  recoverDisconnect(runId: string): void {
    const raw = readCheckedHostRunFile(this.context.stateDir, ["runs", runId, "disconnect.json"]);
    if (!raw) return;
    let deadlineAt: string, mode: "cancel" | "unlaunched";
    try {
      const record = hostRunDisconnectSchema.parse(JSON.parse(raw.toString("utf8")));
      deadlineAt = record.deadlineAt; mode = record.mode ?? "cancel";
    } catch { return; }
    const remaining = Date.parse(deadlineAt) - this.context.nowMs();
    if (remaining <= 0) this.fireDisconnect(runId, mode);
    else this.armDisconnect(runId, remaining, mode);
  }

  outputSize(runId: string, stream: "stdout" | "stderr"): number | null {
    let fd: number | null = null;
    try {
      fd = openVerifiedOwnedFile(this.context.stateDir, ["runs", runId, stream], constants.O_RDONLY, 0o600);
      return fstatSync(fd).size;
    } catch { return null; }
    finally { if (fd !== null) closeSync(fd); }
  }

  readOutput(runId: string, stream: "stdout" | "stderr", offset: number, length: number): Buffer | null {
    let fd: number | null = null;
    try {
      fd = openVerifiedOwnedFile(this.context.stateDir, ["runs", runId, stream], constants.O_RDONLY, 0o600);
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, offset);
      return read === length ? buffer : buffer.subarray(0, read);
    } catch { return null; }
    finally { if (fd !== null) closeSync(fd); }
  }

  readonly attachments = new Set<Attachment>();

  readonly disconnectTimers = new Map<string, NodeJS.Timeout>();
}
