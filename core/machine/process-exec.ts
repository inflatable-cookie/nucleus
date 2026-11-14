import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DEFAULT_PROCESS_TERMINATION_GRACE_MS, PROCESS_TERMINATION_GRACE_MAX_MS, type HostRunEscapedDescendant } from "../../shared/contracts";
import { withSpawnSlot } from "../dispatch/spawn-gate";
import { processGroupEmpty, signalProcessGroup, waitForProcessGroupEmpty } from "./process-group";
import { processStartIdentityEnvironment, processesForStartIdentity } from "./process-identity-search";
import { hostRunProcessStartIdentity } from "./start-identity";
import { BoundedStreamRetention, FailureFirstStreamRetention } from "./output-retention";

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
      if (error) reject(error); else resolve(outcome);
    };
    const terminateGroup = (cause: "timeout" | "cancel" | "overflow") => {
      if (cause === "timeout" && !outcome.cancelled) outcome.timedOut = true;
      if (cause === "cancel") outcome.cancelled = true;
      if (termination) return termination;
      termination = (async () => {
        const pgid = outcome.processGroupId;
        const identity = outcome.leaderStartIdentity;
        if (!pgid || !identity) {
          outcome.terminationError = "Process-group identity is unavailable; no signal was sent";
          outcome.processGroupEmpty = false;
          return;
        }
        try {
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
    const finishWhenGroupIsEmpty = async () => {
      if (settled || finishing || !leaderExited) return;
      if (!request.settleOnProcessGroup || !processGroupId) {
        if (!pipesClosed) return;
        // A signalled leader can exit before its group's termination is
        // recorded; settle with that record, not ahead of it.
        if (termination) { finishing = true; await termination; }
        settle();
        return;
      }
      if (!processGroupEmpty(processGroupId)) return;
      finishing = true;
      outcome.processGroupEmpty = true;
      const descendants = processesForStartIdentity(leaderStartIdentity);
      outcome.escapedDescendants = descendants.state === "found"
        ? descendants.processes.filter(process => process.processGroupId !== processGroupId)
          .map(process => ({ pid: process.pid, startIdentity: process.startIdentity }))
        : [];
      // Let already-buffered pipe data reach the readers. The process group is
      // the settlement boundary; an escaped descendant holding a pipe cannot
      // keep this step alive after this point.
      await new Promise<void>(resolveNext => setImmediate(resolveNext));
      if (termination) await termination;
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      settle();
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
        groupTimer = setInterval(() => { void finishWhenGroupIsEmpty(); }, 20);
        groupTimer.unref?.();
      }
    });
    const observe = (stream: "stdout" | "stderr", chunk: Buffer) => {
      try { request.onOutput?.(stream, chunk); } catch { /* observation never breaks execution */ }
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
    child.on("exit", (code, signal) => {
      outcome.code = code;
      outcome.signal = signal;
      leaderExited = true;
      void finishWhenGroupIsEmpty();
    });
    child.on("close", () => { pipesClosed = true; void finishWhenGroupIsEmpty(); });
    child.stdin.on("error", () => { /* A hook that closes stdin early is still observed through its exit. */ });
    child.stdin.end(request.stdin);
  }));
}

