import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import type { HostRunEscapedDescendant } from "../../shared/contracts";
import type { HostRunScheduler } from "../host-runs/host-run-scheduler";
import { processCommandLine } from "../machine/process-identity";
import { processStartIdentityLiveness } from "../machine/process-group";
import { cwdMapFromLsof } from "../workspaces/worktree-validation";

const sleep = (ms: number) => new Promise<void>(resolvePromise => { setTimeout(resolvePromise, ms); });
/** Capacity holds for escaped descendants resume from settled rows after service rolls. */
const qaEscapedDescendantWatchers = new Map<string, Promise<void>>();
export interface QaEscapeeContext {
  hostRuns: Pick<HostRunScheduler, "get" | "markEscapedDescendantsDead">;
  options: { supervisionPollMs?: number };
}
export const projectQaEscapees = {
  /** Retain settled capacity until every recorded escaped PID is proven to be the same dead process. */
  watchEscapedDescendants(this: QaEscapeeContext, runId: string): void {
    if (qaEscapedDescendantWatchers.has(runId)) return;
    const pollMs = Math.max(25, this.options.supervisionPollMs ?? 1_000);
    const watching = (async () => {
      for (;;) {
        const scheduled = this.hostRuns.get(runId);
        if (!scheduled || scheduled.state !== "settled" || scheduled.capacityReleasedAt) return;
        const escaped = scheduled.settlement?.result?.escapedDescendants ?? [];
        if (!escaped.length || scheduled.escapedDescendantsProvenDeadAt) return;
        if (escaped.every(descendant => processStartIdentityLiveness(descendant.pid, descendant.startIdentity) === "dead")) {
          this.hostRuns.markEscapedDescendantsDead(runId, escaped);
          return;
        }
        await sleep(pollMs);
      }
    })().finally(() => { qaEscapedDescendantWatchers.delete(runId); });
    qaEscapedDescendantWatchers.set(runId, watching);
    void watching.catch(() => { /* the next run-list sweep resumes the durable hold */ });
  }
};

/** True when an absolute path sits inside one of the roots (string comparison only). */
function pathWithinRoots(candidate: string, roots: readonly string[]): boolean {
  return roots.some(root => candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`));
}

/**
 * True when an escaped descendant is rooted in the QA worktree. A cwd inside
 * the checkout or run root proves it, as does an absolute argv containing a
 * root. A *known-outside* cwd disproves rooting outright. Only when the cwd
 * is unreadable does a relative script argv naming a file inside the roots
 * count: the pid is already proven by start identity to be this run's own
 * descendant, so `node bin/queue-service.mjs` with no readable cwd is still
 * provably ours when that script exists in the checkout.
 */
export function escapeeRootedInWorktree(
  process: { cwd: string | null; command: string | null; argv?: readonly string[] | null },
  roots: { checkoutPath: string; runRoot: string },
): boolean {
  const list = [roots.checkoutPath, roots.runRoot];
  if (process.cwd && pathWithinRoots(process.cwd, list)) return true;
  if (process.command && list.some(root => process.command!.includes(root))) return true;
  if (process.cwd !== null) return false;
  for (const token of (process.argv ?? []).slice(0, 12)) {
    if (!token || token.startsWith("-") || isAbsolute(token) || token.includes("://")) continue;
    if (!/\.(mjs|cjs|js|ts|sh)$/.test(token)) continue;
    for (const root of list) {
      const resolved = join(root, token);
      if (pathWithinRoots(resolved, [root]) && existsSync(resolved)) return true;
    }
  }
  return false;
}

function readEscapeeCwd(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try { return readlinkSync(`/proc/${pid}/cwd`, "utf8"); }
  catch { return null; }
}

/** Read every escapee cwd in one OS pass (one lsof on macOS, /proc on Linux). */
function readEscapeeCwds(pids: readonly number[]): Map<number, string | null> {
  const found = new Map<number, string | null>();
  if (!pids.length) return found;
  if (process.platform === "linux") {
    for (const pid of pids) found.set(pid, readEscapeeCwd(pid));
    return found;
  }
  if (process.platform === "darwin") {
    const map = cwdMapFromLsof(pids as number[], spawnSync("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")], {
      encoding: "utf8", timeout: 5_000,
    }));
    for (const pid of pids) {
      const state = map?.get(pid);
      found.set(pid, state?.state === "read" ? state.path : null);
    }
    return found;
  }
  for (const pid of pids) found.set(pid, null);
  return found;
}

/** The escapee's argv: exact from /proc on Linux, best-effort tokens elsewhere. */
function readEscapeeArgv(pid: number): string[] | null {
  if (process.platform === "linux") {
    try {
      const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(part => part !== "");
      return parts.length ? parts : null;
    } catch { return null; }
  }
  const line = processCommandLine(pid);
  if (!line) return null;
  const tokens = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!tokens) return null;
  return tokens.map(token => token.replace(/^(["'])(.*)\1$/, "$2")).filter(token => token !== "");
}

export interface QaEscapeeReapProbes {
  liveness?(pid: number, startIdentity: string): "alive" | "dead" | "unknown";
  cwd?(pid: number): string | null;
  command?(pid: number): string | null;
  argv?(pid: number): readonly string[] | null;
  signal?(pid: number, signal: NodeJS.Signals): void;
  sleep?(ms: number): Promise<void>;
}

export interface QaEscapeeReapResult {
  reaped: Array<{ pid: number; startIdentity: string }>;
  held: Array<{ pid: number; startIdentity: string; reason: string }>;
}

const reapSleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

/**
 * Task 191: after the QA step and teardown, terminate the run's own escaped
 * descendants that are rooted in its Queue-owned QA worktree (by cwd or
 * argv), so the scheduler can prove them dead and release capacity. Every
 * signal names the exact pid only after its recorded start identity is proven
 * alive — never a command pattern — and the identity is re-proven before the
 * SIGKILL escalation. Escapees outside the worktree, unreadable ones and
 * survivors keep today's hold: they stay recorded and are returned as held.
 */
export async function reapQaWorktreeEscapees(
  escaped: ReadonlyArray<HostRunEscapedDescendant>,
  roots: { checkoutPath: string; runRoot: string },
  options: { graceMs?: number } & QaEscapeeReapProbes = {},
): Promise<QaEscapeeReapResult> {
  const graceMs = Math.max(0, options.graceMs ?? 5_000);
  const liveness = options.liveness ?? processStartIdentityLiveness;
  const readCommand = options.command ?? (pid => processCommandLine(pid));
  const readArgv = options.argv ?? readEscapeeArgv;
  const signal = options.signal ?? ((pid, sig) => { process.kill(pid, sig); });
  const sleep = options.sleep ?? reapSleep;
  const reaped: QaEscapeeReapResult["reaped"] = [];
  const held: QaEscapeeReapResult["held"] = [];
  const seen = new Set<string>();
  const live: HostRunEscapedDescendant[] = [];
  for (const descendant of escaped) {
    const key = `${descendant.pid}:${descendant.startIdentity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (liveness(descendant.pid, descendant.startIdentity) === "alive") live.push(descendant);
  }
  // One OS pass for every cwd (a single lsof on macOS), unless tests inject
  // per-pid reads.
  const cwdBatch: Map<number, string | null> = options.cwd ? new Map() : readEscapeeCwds(live.map(descendant => descendant.pid));
  for (const descendant of live) {
    const cwd = options.cwd ? options.cwd(descendant.pid) : (cwdBatch.get(descendant.pid) ?? null);
    const command = readCommand(descendant.pid);
    const argv = readArgv(descendant.pid);
    if (liveness(descendant.pid, descendant.startIdentity) !== "alive") continue;
    if (!cwd && !command && !(argv?.length)) {
      held.push({ pid: descendant.pid, startIdentity: descendant.startIdentity, reason: "location unreadable" });
      continue;
    }
    if (!escapeeRootedInWorktree({ cwd, command, argv }, roots)) {
      held.push({ pid: descendant.pid, startIdentity: descendant.startIdentity, reason: "outside the QA worktree" });
      continue;
    }
    try { signal(descendant.pid, "SIGTERM"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      held.push({ pid: descendant.pid, startIdentity: descendant.startIdentity, reason: "SIGTERM was refused" });
      continue;
    }
    const deadline = Date.now() + graceMs;
    while (liveness(descendant.pid, descendant.startIdentity) === "alive" && Date.now() < deadline) {
      await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    }
    if (liveness(descendant.pid, descendant.startIdentity) !== "alive") {
      reaped.push({ pid: descendant.pid, startIdentity: descendant.startIdentity });
      continue;
    }
    try { signal(descendant.pid, "SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        reaped.push({ pid: descendant.pid, startIdentity: descendant.startIdentity });
        continue;
      }
      held.push({ pid: descendant.pid, startIdentity: descendant.startIdentity, reason: "SIGKILL was refused" });
      continue;
    }
    const killDeadline = Date.now() + Math.min(1_000, graceMs);
    while (liveness(descendant.pid, descendant.startIdentity) === "alive" && Date.now() < killDeadline) {
      await sleep(Math.min(50, Math.max(0, killDeadline - Date.now())));
    }
    if (liveness(descendant.pid, descendant.startIdentity) !== "alive")
      reaped.push({ pid: descendant.pid, startIdentity: descendant.startIdentity });
    else held.push({ pid: descendant.pid, startIdentity: descendant.startIdentity, reason: "still running after SIGKILL" });
  }
  return { reaped, held };
}
