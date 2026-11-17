import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DEFAULT_PROCESS_TERMINATION_GRACE_MS, PROCESS_TERMINATION_GRACE_MAX_MS, type HostRunEscapedDescendant } from "../../shared/contracts";
import { withSpawnSlot } from "../dispatch/spawn-gate";
import { ESCAPED_DESCENDANT_SCAN_MS, EscapedDescendantCustody, escapedDescendantsOf } from "./escaped-descendants";
import { processGroupEmpty, signalProcessGroup, waitForProcessGroupEmpty } from "./process-group";
import { processStartIdentityEnvironment, processStartIdentityLiveness, processesForStartIdentity } from "./process-identity-search";
import { hostRunProcessStartIdentity } from "./start-identity";
import { BoundedStreamRetention, FailureFirstStreamRetention } from "./output-retention";

/**
 * Spec 064 P2: one parent's own child exit observation. It is the parent's
 * `exit` event for the child it spawned — never a census, an EOF or a PID poll —
 * and it carries both start identities so a reused pid reads as a different
 * process.
 */
export interface DirectChildWait {
  parentPid: number;
  parentStartIdentity: string;
  childPid: number;
  childStartIdentity: string | null;
  state: "observed" | "unknown";
  code: number | null;
  signal: string | null;
  observedAt: string;
  /** The one evidence kind this observation can have. */
  source: "child-exit-event";
}

/**
 * Spec 064 P3: what a `qualification_direct` stop did. Every field is recorded
 * so a reader sees that no group, escaped-descendant or KILL signal was sent.
 */
export interface QualificationStop {
  mode: "qualification_direct";
  cause: "timeout" | "cancel" | "overflow";
  pid: number;
  startIdentity: string;
  signal: "SIGTERM" | null;
  groupSignalled: false;
  escapedDescendantSignalled: false;
  killEscalated: false;
  error: string | null;
}

/**
 * Spec 064 P4: one stream's real terminal observations. EOF is the pipe's own
 * `end` event, never a group emptiness or a destroyed pipe; DRAIN follows once
 * every observed payload write for that stream completed.
 */
export interface StreamTerminalObservation {
  eof: "observed" | "unknown";
  drained: "observed" | "unknown";
  eofAt: string | null;
  drainedAt: string | null;
}

/** One capture's two streams, keyed by the stream name the pipes use. */
export type StreamTerminals = Record<"stdout" | "stderr", StreamTerminalObservation>;

export interface ExecutionOutcome {
  pid: number | null; code: number | null; signal: string | null; timedOut: boolean;
  stdoutExceeded: boolean; stderrExceeded: boolean; stdout: Buffer; stderr: Buffer; durationMs: number;
  /**
   * Task 388: bytes each stream produced before its cap, and bytes that cap never
   * kept. `stdout`/`stderr` then hold the beginning, one truncation marker and
   * the end. A capped stream is never recorded as if it were complete output.
   */
  stdoutObservedBytes?: number; stderrObservedBytes?: number;
  stdoutOmittedBytes?: number; stderrOmittedBytes?: number;
  startedAt?: string; endedAt?: string;
  processGroupId?: number | null; leaderStartIdentity?: string | null; startIdentity?: string | null;
  escapedDescendants?: HostRunEscapedDescendant[]; cancelled?: boolean;
  terminationSignal?: "SIGTERM" | "SIGKILL" | null; processGroupEmpty?: boolean | null; terminationError?: string | null;
  /** Spec 064 P2: this step's own direct-command exit observation, when the caller asked for it. */
  directChildWait?: DirectChildWait;
  /** Spec 064 P3: what a `qualification_direct` stop did, when that mode was requested. */
  qualificationStop?: QualificationStop;
  /**
   * Spec 064 P4: what qualification capture observed, recorded only when the
   * caller asked for it. A missing EOF stays `unknown`, never inferred.
   */
  streamTerminals?: StreamTerminals;
  /** Spec 064 P4: the first strict-capture observer fault, when one latched. */
  captureFault?: string;
  /**
   * Spec 064 P4 (amended): the strict capture's EOF wait hit its bound, so one or
   * both streams are not terminal. The terminals stay `unknown`; nothing
   * manufactures EOF, no extra signal is sent and no cleanup time is granted.
   */
  eofWaitTimedOut?: boolean;
}

const POST_KILL_PROCESS_GROUP_WAIT_MS = 5_000;
const PROCESS_GROUP_IDENTITY_WAIT_MS = 1_000;

export interface ExecutionRequest {
  root: string; executable: string; argv: string[]; stdin: Buffer; timeoutMs: number; maxOutputBytes: number;
  env: Record<string, string>; onSpawn?: (pid: number, processGroupId?: number, leaderStartIdentity?: string, startIdentity?: string) => void;
  /** Stable run identity inherited by every process in this step and its descendants. */
  processStartIdentity?: string;
  /** Settle on process-group emptiness and record escaped descendants for host runs. */
  settleOnProcessGroup?: boolean;
  /**
   * Contract 010's second settlement condition (host runs): settle only once the
   * run's escaped descendants are proven absent too. The step stays live while it
   * waits — its pipes stay open, its cancel request is still polled, its timeout
   * still applies, and a descendant that left the group is signalled with the
   * stage the stop reached, including one discovered after escalation. Callers
   * that do not ask for it keep today's single settled inventory.
   */
  settleOnEscapedDescendants?: boolean;
  /** Cancellation request, polled while a cancellable step is running. */
  cancelReason?: () => string | null;
  /**
   * What happens past maxOutputBytes. `terminate` (hooks) kills the program: a hook's
   * output is its result, so partial output is never accepted. `tail` (project
   * validation) keeps a bounded beginning and end of each stream inside the same
   * cap and lets the program finish, because its exit code is the result and the
   * output is only a diagnostic.
   */
  overflow?: "terminate" | "tail";
  /**
   * Task 590: with `overflow: "tail"`, trim passing test lines (`ok`, the
   * spec check mark and their diagnostic continuations) before failure lines,
   * so a capped milestone QA step log keeps the failures a fix worker needs.
   * Other callers keep today's beginning-and-end shape; validation output is
   * not test output and stays on it.
   */
  trimPassingFirst?: boolean;
  /** SIGTERM grace before group SIGKILL; defaults to the Queue process setting or 30 seconds. */
  terminationGraceMs?: number;
  /**
   * Spec 064 P3: how a stop behaves. Absent or `group` is Contract 010's group
   * stop, unchanged. `qualification_direct` signals only the still-held direct
   * command with TERM: no group signal, no escaped-descendant signal, no KILL
   * escalation, and the supervisor is never the target of a cleanup shortcut.
   */
  stopMode?: "group" | "qualification_direct";
  /**
   * Spec 064 P2: record this step's own direct-command exit observation (the
   * parent's child `exit` event, with both start identities).
   */
  directChildWait?: boolean;
  /** Spec 064 P2: the same observation as it is made, before any group settlement. */
  onChildExit?: (wait: DirectChildWait) => void;
  /**
   * Spec 064 P4: this step's capture is its result. An observer fault (a failed
   * DATA frame, a terminal marker that could not be written) latches, requests
   * the stop through `stopMode`, and rejects the step instead of being dropped;
   * pipes are not destroyed and settlement waits for each stream's real terminal
   * event. Absent, observation stays the diagnostic it has always been.
   */
  qualificationCapture?: boolean;
  /**
   * Spec 064 P4 (amended): the absolute tick by which the strict capture's EOF
   * wait must end. A pipe held open outside the group cannot keep the wait
   * unbounded, and the wait never buys extra time: it is the attempt's own
   * first-effect deadline (`originTick + targetMs`), measured from the origin, so
   * the remaining target at the moment the wait begins is all that is left. When
   * it expires the streams stay `unknown` and the step settles. Gated with
   * `qualificationCapture`.
   */
  eofWaitDeadlineMs?: number;
  /**
   * Spec 064 P4: each stream's real pipe EOF, on that stream's own `end` event.
   * These are the strict capture's events: with `qualificationCapture` absent the
   * listener is not registered and the callback never fires.
   */
  onStreamEof?: (stream: "stdout" | "stderr") => void;
  /**
   * Spec 064 P4: every observed payload write for that stream completed after
   * its EOF, so the capture can close that stream's terminal obligation. Gated
   * with `qualificationCapture` like `onStreamEof`.
   */
  onStreamDrained?: (stream: "stdout" | "stderr") => void;
  /**
   * Task 191: streaming observer for every output chunk as it arrives, before
   * any maxOutputBytes capping. Milestone QA feeds TAP chunks here so a
   * failure block stays visible even when the retained window evicts it.
   */
  onOutput?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
}

/** Spawn one pinned regular executable directly with literal argv. No shell is involved. */
export function executeHookProgram(request: ExecutionRequest): Promise<ExecutionOutcome> {
  return withSpawnSlot(() => new Promise((resolve, reject) => {
    const started = Date.now();
    const leaderStartIdentity = request.processStartIdentity ?? randomUUID();
    const child = spawn(request.executable, request.argv, {
      cwd: request.root, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      env: { ...request.env, ...processStartIdentityEnvironment(leaderStartIdentity) },
    });
    let processGroupId: number | null = null;
    const outcome: ExecutionOutcome = { pid: null, code: null, signal: null, timedOut: false,
      stdoutExceeded: false, stderrExceeded: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), durationMs: 0,
      processGroupId, leaderStartIdentity, terminationSignal: null, processGroupEmpty: null, terminationError: null };
    const escapedCustody = request.settleOnEscapedDescendants ? new EscapedDescendantCustody(leaderStartIdentity) : null;
    /** Spec 064 P3: the qualification stop owns every signal decision when it is selected. */
    const cooperativeStop = request.stopMode === "qualification_direct";
    /**
     * Spec 064 P4: qualification capture owns the step's result, so an observer
     * fault latches and requests the stop, pipes are never destroyed to
     * manufacture completion, and settlement waits for each stream's own
     * terminal event.
     */
    const strictCapture = request.qualificationCapture === true;
    const streamTerminals: StreamTerminals = {
      stdout: { eof: "unknown", drained: "unknown", eofAt: null, drainedAt: null },
      stderr: { eof: "unknown", drained: "unknown", eofAt: null, drainedAt: null },
    };
    /** A stream is terminal only after its own `end`, `error` or `close`. */
    const streamEnded = { stdout: false, stderr: false };
    const streamsTerminal = (): boolean => streamEnded.stdout && streamEnded.stderr;
    let captureFault: Error | null = null;
    /**
     * Spec 064 P4 (amended): the bounded EOF wait for the strict capture. The
     * bound is the attempt's own first-effect deadline, so the wait can only spend
     * what is left of the target — never a fresh span from when the wait starts. A
     * deadline already past settles at once.
     */
    const eofWaitDeadlineMs = strictCapture && Number.isFinite(request.eofWaitDeadlineMs) ? request.eofWaitDeadlineMs! : null;
    let eofWaitTimer: NodeJS.Timeout | null = null;
    let eofWaitExpired = false;
    const boundEofWait = (): boolean => {
      if (eofWaitExpired) return true;
      if (eofWaitDeadlineMs === null || eofWaitTimer) return false;
      const remainingMs = Math.max(1, eofWaitDeadlineMs - Date.now());
      eofWaitTimer = setTimeout(() => {
        eofWaitExpired = true;
        outcome.eofWaitTimedOut = true;
        void finishWhenGroupIsEmpty();
      }, remainingMs);
      eofWaitTimer.unref?.();
      return false;
    };
    /** The last escaped-descendant scan, so a settlement tick never reads the host table every 20 ms. */
    let lastEscapedScanAt = 0;
    /** When the stop began, so escaped descendants get the same grace the group does. */
    let terminationAt: number | null = null;
    const failureFirst = request.trimPassingFirst === true && request.overflow === "tail";
    const retentions = {
      stdout: failureFirst
        ? new FailureFirstStreamRetention(request.maxOutputBytes)
        : new BoundedStreamRetention(request.maxOutputBytes, request.overflow === "tail"),
      stderr: failureFirst
        ? new FailureFirstStreamRetention(request.maxOutputBytes)
        : new BoundedStreamRetention(request.maxOutputBytes, request.overflow === "tail"),
    };
    let settled = false;
    let termination: Promise<void> | null = null;
    let timer: NodeJS.Timeout | null = null, cancelTimer: NodeJS.Timeout | null = null, groupTimer: NodeJS.Timeout | null = null;
    let leaderExited = false, pipesClosed = false, finishing = false;
    const graceMs = Math.max(0, Math.min(PROCESS_TERMINATION_GRACE_MAX_MS,
      Number.isInteger(request.terminationGraceMs) ? request.terminationGraceMs! :
        DEFAULT_PROCESS_TERMINATION_GRACE_MS));
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (eofWaitTimer) clearTimeout(eofWaitTimer);
      if (cancelTimer) clearInterval(cancelTimer);
      if (groupTimer) clearInterval(groupTimer);
      outcome.durationMs = Date.now() - started;
      // A capped stream keeps its beginning, a marker and its end; the counts are
      // recorded beside it so nothing reads as complete output.
      outcome.stdout = retentions.stdout.render(request.overflow === "tail");
      outcome.stderr = retentions.stderr.render(request.overflow === "tail");
      outcome.stdoutObservedBytes = retentions.stdout.observedBytes;
      outcome.stderrObservedBytes = retentions.stderr.observedBytes;
      outcome.stdoutOmittedBytes = retentions.stdout.omittedBytes;
      outcome.stderrOmittedBytes = retentions.stderr.omittedBytes;
      outcome.endedAt = new Date().toISOString();
      if (strictCapture) outcome.streamTerminals = streamTerminals;
      // A strict capture's fault rejects the step, carrying what was observed so
      // the caller can retain the partial artifact and report the stop.
      if (error && captureFault) reject(Object.assign(error, { outcome }));
      else if (error) reject(error);
      else resolve(outcome);
    };
    /**
     * Spec 064 P3: the qualification stop. Every timeout, cancel, overflow,
     * failure and exception sends TERM to the one still-held direct command and
     * nothing else: no process group, no escaped descendant, no SIGKILL
     * escalation, and never this supervisor. After an effect the command's own
     * closure is retained as unknown rather than escalated.
     */
    const terminateDirect = (cause: "timeout" | "cancel" | "overflow"): Promise<void> => {
      if (termination) return termination;
      terminationAt = Date.now();
      const pid = outcome.pid;
      const identity = outcome.startIdentity ?? null;
      const record: QualificationStop = {
        mode: "qualification_direct", cause, pid: pid ?? 0, startIdentity: identity ?? "", signal: null,
        groupSignalled: false, escapedDescendantSignalled: false, killEscalated: false, error: null,
      };
      outcome.qualificationStop = record;
      termination = (async () => {
        if (!pid || !identity) {
          record.error = "The direct command's identity was never established; no signal was sent";
          return;
        }
        // Only the process this step started, and only while its recorded start
        // identity still matches, so a reused pid is never signalled.
        if (processStartIdentityLiveness(pid, identity) !== "alive") {
          record.error = "The direct command is no longer alive under its recorded start identity";
          return;
        }
        try {
          process.kill(pid, "SIGTERM");
          record.signal = "SIGTERM";
          outcome.terminationSignal = "SIGTERM";
        } catch (error) {
          record.error = `The direct command's cooperative stop failed: ${String(error)}`;
        }
      })();
      return termination;
    };
    const terminateGroup = (cause: "timeout" | "cancel" | "overflow") => {
      if (cause === "timeout" && !outcome.cancelled) outcome.timedOut = true;
      if (cause === "cancel") outcome.cancelled = true;
      // The qualification stop is selected before any group, escapee or KILL path.
      if (cooperativeStop) return terminateDirect(cause);
      if (termination) return termination;
      terminationAt = Date.now();
      termination = (async () => {
        const pgid = outcome.processGroupId;
        const identity = outcome.leaderStartIdentity;
        if (!pgid || !identity) {
          outcome.terminationError = "Process-group identity is unavailable; no signal was sent";
          outcome.processGroupEmpty = false;
          return;
        }
        try {
          // A descendant that left the group takes the same first signal: the
          // group may already be empty while it still runs.
          escapedCustody?.signal("SIGTERM");
          const signalWhenProven = async (signal: NodeJS.Signals) => {
            const deadline = Date.now() + PROCESS_GROUP_IDENTITY_WAIT_MS;
            for (;;) {
              if (processGroupEmpty(pgid)) return false;
              // While the leader is our own unreaped child, its pid (the group id)
              // cannot be reused, so the group is ours without a `ps` proof. That
              // proof can fail under load or before exec, and an unsignalled step
              // never settles.
              if (!leaderExited) {
                try { process.kill(-pgid, signal); return true; }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
              }
              if (signalProcessGroup(pgid, identity, signal)) return true;
              if (Date.now() >= deadline) return false;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
          };
          if (!await signalWhenProven("SIGTERM")) {
            outcome.processGroupEmpty = processGroupEmpty(pgid);
            if (!outcome.processGroupEmpty) outcome.terminationError = "Could not prove the recorded process-group identity; no signal was sent";
            return;
          }
          outcome.terminationSignal = "SIGTERM";
          if (await waitForProcessGroupEmpty(pgid, graceMs)) {
            outcome.processGroupEmpty = true;
            return;
          }
          escapedCustody?.signal("SIGKILL");
          if (await signalWhenProven("SIGKILL")) outcome.terminationSignal = "SIGKILL";
          else outcome.terminationError = "Could not prove the recorded process-group identity for SIGKILL";
          outcome.processGroupEmpty = await waitForProcessGroupEmpty(pgid, POST_KILL_PROCESS_GROUP_WAIT_MS);
          if (!outcome.processGroupEmpty && !outcome.terminationError)
            outcome.terminationError = "The recorded process group remained after SIGKILL";
        } catch (error) {
          outcome.terminationError = `Process-group termination failed: ${String(error)}`;
          outcome.processGroupEmpty = processGroupEmpty(pgid);
        }
      })();
      return termination;
    };
    /**
     * Spec 064 P4: latch the first strict-capture observer fault and request the
     * stop this step's mode selected. The step reports it by rejecting; nothing
     * here destroys a pipe or writes a marker on the capture's behalf.
     */
    const latchCaptureFault = (error: unknown) => {
      if (captureFault) return;
      captureFault = error instanceof Error ? error : new Error(String(error));
      outcome.captureFault = captureFault.message;
      void terminateGroup("overflow");
    };
    /**
     * One bounded proof of absence. The full identity listing records every
     * descendant that left the group and answers whether the run may settle; when
     * the stop has a stage, the descendants this listing just found are signalled
     * with it, so one that leaves the group after the escalation is still stopped.
     */
    const proveEscapedAbsence = (pgid: number, stopAt: number | null): boolean => {
      if (!escapedCustody) return true;
      const now = Date.now();
      if (now - lastEscapedScanAt < ESCAPED_DESCENDANT_SCAN_MS) return false;
      lastEscapedScanAt = now;
      if (escapedCustody.absenceProven(pgid, now)) return true;
      // Spec 064 P3: a qualification stop never signals an escaped descendant.
      if (stopAt !== null && !cooperativeStop) {
        const escalated = outcome.terminationSignal === "SIGKILL" || now - stopAt >= graceMs;
        escapedCustody.signal(escalated ? "SIGKILL" : "SIGTERM");
      }
      return false;
    };
    /**
     * One settlement tick: inventory escaped descendants while the run's group
     * still holds processes, whatever the leader state. A same-group descendant
     * can outlive its leader, detach a `setsid` child and exit, so inventorying
     * only while the leader lives would miss it while the group survives; the
     * global proof runs once the group is empty. Then try to settle.
     */
    const pollSettlement = () => {
      if (settled || finishing) return;
      if (escapedCustody && processGroupId && !processGroupEmpty(processGroupId)) {
        const now = Date.now();
        if (now - lastEscapedScanAt >= ESCAPED_DESCENDANT_SCAN_MS) {
          lastEscapedScanAt = now;
          escapedCustody.scan(processGroupId);
        }
      }
      void finishWhenGroupIsEmpty();
    };
    const finishWhenGroupIsEmpty = async () => {
      if (settled || finishing || !leaderExited) return;
      if (!request.settleOnProcessGroup || !processGroupId) {
        // Spec 064 P4: a strict capture waits for both streams' real terminals.
        if (strictCapture ? !streamsTerminal() && !boundEofWait() : !pipesClosed) return;
        // A signalled leader can exit before its group's termination is
        // recorded; settle with that record, not ahead of it.
        if (termination) { finishing = true; await termination; }
        settle(captureFault ?? undefined);
        return;
      }
      if (!processGroupEmpty(processGroupId)) return;
      if (escapedCustody && !proveEscapedAbsence(processGroupId, terminationAt)) return;
      // Spec 064 P4: never destroy a pipe to manufacture completion. The strict
      // capture settles only after each stream's own terminal event.
      if (strictCapture && !streamsTerminal() && !boundEofWait()) return;
      finishing = true;
      outcome.processGroupEmpty = true;
      // The escaped-descendant rule has one owner: this is its settled inventory,
      // recorded as a fact so a leak stays visible instead of holding capacity.
      outcome.escapedDescendants = escapedCustody
        ? escapedCustody.recorded()
        : escapedDescendantsOf(processesForStartIdentity(leaderStartIdentity), processGroupId);
      // Let already-buffered pipe data reach the readers. The process group is
      // the settlement boundary; an escaped descendant holding a pipe cannot
      // keep this step alive after this point.
      await new Promise<void>(resolveNext => setImmediate(resolveNext));
      if (termination) await termination;
      if (!strictCapture) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
      }
      settle(captureFault ?? undefined);
    };
    child.on("error", error => {
      if (outcome.processGroupId) void terminateGroup("overflow");
      else settle(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("spawn", () => {
      outcome.pid = child.pid ?? null;
      processGroupId = process.platform === "win32" ? null : child.pid ?? null;
      outcome.processGroupId = processGroupId;
      if (child.pid) {
        outcome.startedAt = new Date().toISOString();
        outcome.startIdentity = hostRunProcessStartIdentity(child.pid);
        try { request.onSpawn?.(child.pid, processGroupId ?? undefined, leaderStartIdentity, outcome.startIdentity); }
        catch { void terminateGroup("overflow"); }
      }
      timer = setTimeout(() => { void terminateGroup("timeout"); }, request.timeoutMs);
      if (request.cancelReason && processGroupId) {
        cancelTimer = setInterval(() => {
          let reason: string | null = null;
          try { reason = request.cancelReason?.() ?? null; } catch { /* a transient read cannot cancel a run */ }
          if (reason) {
            outcome.cancelled = true;
            void terminateGroup("cancel");
          }
        }, 50);
      }
      if (request.settleOnProcessGroup && processGroupId) {
        groupTimer = setInterval(pollSettlement, 20);
        groupTimer.unref?.();
      }
    });
    const observe = (stream: "stdout" | "stderr", chunk: Buffer) => {
      try { request.onOutput?.(stream, chunk); }
      catch (error) {
        // Spec 064 P4: a capture that owns the result cannot lose a chunk quietly.
        if (strictCapture) latchCaptureFault(error);
      }
      const retention = retentions[stream];
      const exceeded = retention.observedBytes + chunk.length > request.maxOutputBytes;
      if (exceeded && request.overflow !== "tail") {
        // A hook's output is its result: past the cap the program is killed and
        // the partial bytes are never accepted. The kept prefix stays contiguous.
        outcome[stream === "stdout" ? "stdoutExceeded" : "stderrExceeded"] = true;
        retention.observe(chunk);
        void terminateGroup("overflow");
        return;
      }
      retention.push(chunk);
      if (exceeded) outcome[stream === "stdout" ? "stdoutExceeded" : "stderrExceeded"] = true;
    };
    child.stdout.on("data", (chunk: Buffer) => observe("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => observe("stderr", chunk));
    // Spec 064 P4: the strict capture's whole terminal machinery — its pipe
    // listeners included — is registered only when that mode is selected. An
    // ordinary step keeps exactly the listeners it always had, and its own
    // settlement still follows the child's `close`, not a stream event.
    if (strictCapture) {
      /**
       * Spec 064 P4: the real per-stream terminal sequence. `end` is that pipe's
       * own EOF; the drain follows once this step's synchronous payload
       * observation for the stream is complete. A stream that errors or closes
       * without `end` keeps `unknown` EOF, so settlement can still happen and the
       * gap stays visible.
       */
      const observeStreamEof = (stream: "stdout" | "stderr") => {
        if (streamEnded[stream]) return;
        streamEnded[stream] = true;
        if (captureFault) return;
        streamTerminals[stream].eof = "observed";
        streamTerminals[stream].eofAt = new Date().toISOString();
        try { request.onStreamEof?.(stream); }
        catch (error) {
          streamTerminals[stream].eof = "unknown";
          streamTerminals[stream].eofAt = null;
          latchCaptureFault(error);
          return;
        }
        if (captureFault) return;
        streamTerminals[stream].drained = "observed";
        streamTerminals[stream].drainedAt = new Date().toISOString();
        try { request.onStreamDrained?.(stream); }
        catch (error) {
          streamTerminals[stream].drained = "unknown";
          streamTerminals[stream].drainedAt = null;
          latchCaptureFault(error);
        }
      };
      for (const stream of ["stdout", "stderr"] as const) {
        const pipe = stream === "stdout" ? child.stdout : child.stderr;
        pipe.on("end", () => { observeStreamEof(stream); void finishWhenGroupIsEmpty(); });
        pipe.on("close", () => { streamEnded[stream] = true; void finishWhenGroupIsEmpty(); });
        pipe.on("error", () => { streamEnded[stream] = true; void finishWhenGroupIsEmpty(); });
      }
    }
    child.on("exit", (code, signal) => {
      outcome.code = code;
      outcome.signal = signal;
      // Spec 064 P2: the parent's own child exit observation, recorded here —
      // before any group settlement. Nothing below infers it from a census, an
      // EOF or a PID poll; both start identities travel with it.
      if (request.directChildWait || request.onChildExit) {
        const wait: DirectChildWait = {
          parentPid: process.pid, parentStartIdentity: hostRunProcessStartIdentity(process.pid),
          childPid: child.pid ?? 0, childStartIdentity: outcome.startIdentity ?? null,
          state: "observed", code, signal, observedAt: new Date().toISOString(), source: "child-exit-event",
        };
        outcome.directChildWait = wait;
        try { request.onChildExit?.(wait); } catch { /* observation never breaks execution */ }
      }
      leaderExited = true;
      void finishWhenGroupIsEmpty();
    });
    child.on("close", () => { pipesClosed = true; void finishWhenGroupIsEmpty(); });
    child.stdin.on("error", () => { /* A hook that closes stdin early is still observed through its exit. */ });
    child.stdin.end(request.stdin);
  }));
}

