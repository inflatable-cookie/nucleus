import { bridgeProcessActions } from "../../service/install/bridge-process-actions";
import {mkdtempSync, rmSync, realpathSync, writeFileSync, readFileSync, mkdirSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {after} from 'node:test';
import assert from 'node:assert/strict';
import { ServiceBridge } from '../../hosts/paseo/plugin/bridge';
import type { Adapter } from '../../core/host';
import { processCommandLine } from '../../core/machine/process-identity';
import { processGroupEmpty } from '../../core/machine/process-group';
import { hostRunProcessStartIdentity, startIdentityMatches } from '../../core/machine/start-identity';

/** `ours` is the only verdict that authorizes a signal; `unknown` is never a clean teardown. */
export type ServiceProof = "ours" | "gone" | "foreign" | "unknown";

/**
 * Ownership verdict for one candidate service process, from the evidence this
 * file recorded about it. The command line is never ownership (milestone
 * 3bf3e818, 2026-10-31): a migration or maintenance wrapper keeps its own argv
 * while it imports the queue-service entry into the same process, so matching
 * `queue-service.mjs` in argv called this file's own live service `foreign` and
 * left it writing into the data directory the fixture was removing (ENOTEMPTY
 * on `<root>/northstar-queue/backups`). A pid this file spawned is owned by
 * that record — the start identity read when the record was made, and the
 * detached process group the fixture service leads — and no argv pattern stands
 * in for it.
 *
 * Safety is unchanged in the other direction. A number the OS recycled no
 * longer matches the recorded start identity, so it is `foreign` and never
 * signalled, even when its command line names our entry. An identity this host
 * cannot read is `unknown`: never signalled, and never counted as settled, so a
 * fixture never disposes a directory behind a process it could not identify.
 *
 * A pid this file did not spawn is `unknown` while it is alive, whatever its
 * command line says (review 5723080357). The file only knows such a pid from an
 * identity file it never saw written, so the number may be a leftover of that
 * file, a recycled sibling's service, or a wrapper whose argv never names the
 * entry it imported — and "argv omits the entry" is therefore not evidence that
 * the process is someone else's. Such a pid is reported and never signalled, and
 * teardown fails rather than returning clean beside it.
 */
export function serviceOwnershipVerdict(input: {
  alive: boolean; zombie: boolean; pid: number;
  /** This file spawned the pid itself (the bridge's `onSpawn`, or an explicit claim). */
  spawned: boolean;
  recordedIdentity: string | null; liveIdentity: string | null;
  groupId: number | null;
}): ServiceProof {
  if (!input.alive || input.zombie) return "gone";
  // Only a recorded spawn owns a process and can ever be signalled.
  if (!input.spawned) return "unknown";
  if (input.recordedIdentity === null || input.liveIdentity === null
    || input.recordedIdentity.endsWith("@unknown") || input.liveIdentity.endsWith("@unknown")) return "unknown";
  if (!startIdentityMatches(input.recordedIdentity, input.liveIdentity)) return "foreign";
  // Bridge-spawned services are detached group leaders, so the process that owns
  // the record also leads the group teardown signals.
  if (input.groupId === null) return "unknown";
  return input.groupId === input.pid ? "ours" : "foreign";
}

/**
 * Record a spawn identity once, from the first observation. The moment the bridge
 * reports the child's pid — before any identity file exists — is the ownership
 * evidence, and nothing observed later may replace it: a later record of the
 * same number would describe whatever process holds that number by then, which
 * is how a recycled pid could pass the identity check and put a foreign group
 * under teardown's signal (review 5723330718). An unreadable first observation
 * stays `@unknown`: it is reported, never signalled and never settled.
 */
export function recordSpawnIdentity(record: Map<number, string>, pid: number, identity: string): boolean {
  if (record.has(pid)) return false;
  record.set(pid, identity);
  return true;
}

/**
 * In-flight work a bridge still owes the data directory: a spawn's readiness
 * wait (which refreshes its claim and clears migration and maintenance
 * markers), the startup-failure record it writes when its child exits, or a
 * roll. `close()` refuses new work but does not abort work already running, so
 * teardown has to let these settle before the fixture disposes the directory
 * (review 5723080357). The bridge exposes no awaitable for this, so the guard
 * reads the two promises it keeps; a rename makes the seam unreadable, which
 * teardown reports instead of assuming settlement.
 */
export function bridgeInFlightWork(bridge: ServiceBridge): Promise<unknown>[] {
  // The bridge keeps its own single-flight connect; the roll scheduler keeps the roll.
  const internals = bridge as unknown as { ensurePromise?: Promise<unknown> | null; roll?: { rolling?: Promise<unknown> | null } };
  if (!("ensurePromise" in internals)) return [Promise.reject(new Error("the fixture cannot observe this bridge's in-flight work"))];
  return [internals.ensurePromise, internals.roll?.rolling]
    .filter((pending): pending is Promise<unknown> => Boolean(pending));
}

/**
 * Liveness of one pid from this host's own probe. Only `ESRCH` proves absence:
 * any other error means the process exists but this host may not signal or
 * inspect it, which is `unknown` — never `gone`, so an unowned live process can
 * never be reported clean (review 5723236447).
 */
export function processLiveness(pid: number): "alive" | "gone" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try { process.kill(pid, 0); return "alive"; }
  catch (error) { return livenessFromProbeError((error as NodeJS.ErrnoException).code); }
}

/** A failed liveness probe: `ESRCH` is the only code that proves the process is gone. */
export function livenessFromProbeError(code: string | undefined): "gone" | "unknown" {
  return code === "ESRCH" ? "gone" : "unknown";
}
export interface ServiceSettlement { pid: number; proof: ServiceProof; groupEmpty: boolean | null }

/** Bound on proving a signalled fixture service and its group have exited. */
const TEARDOWN_WAIT_MS = 10_000;
/**
 * Shared bridge fixtures. Each test file passes its own temp-dir prefix, so the
 * files run in parallel and one file's cleanup never kills another's services.
 */
export function bridgeSupport(prefix: string, options: {
  teardownWaitMs?: number;
  /** Test seam for the start-identity source; production uses the host reader. */
  startIdentity?: (pid: number) => string;
} = {}) {
  const teardownWaitMs = options.teardownWaitMs ?? TEARDOWN_WAIT_MS;
  /** The checkout under test: every fixture service runs its entry from here. */
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  /**
   * Pids this file spawned itself, with the identity read at that moment. This
   * is the positive ownership record: a spawn is owned even when the process
   * keeps a wrapper's argv (see `serviceOwnershipVerdict`). Never cleared, so a
   * later sweep or the file-level guard still knows what this file started. A
   * pid this file did not spawn has no record here and is never signalled.
   */
  const spawnedIdentities = new Map<number, string>();
  const readStartIdentity = (pid: number): string => {
    if (options.startIdentity) return options.startIdentity(pid);
    try { return hostRunProcessStartIdentity(pid); }
    catch { return `${pid}@unknown`; }
  };
  /**
   * Service pids this file spawned through a tracked bridge, for leak-free
   * cleanup. Adding a pid records its start identity immediately — the first and
   * only time — so a later number reuse can never be mistaken for the original
   * service, and the spawn itself is the ownership evidence. Only a spawn made
   * here creates an ownership record; a pid read from a service's own identity
   * file, or from any other later observation, never does.
   */
  class SpawnedPidSet extends Set<number> {
    override add(pid: number): this {
      recordSpawnIdentity(spawnedIdentities, pid, readStartIdentity(pid));
      return super.add(pid);
    }
    /**
     * Record the spawn this file is making right now (the bridge's `onSpawn`).
     * This makes exactly one identity read and stores it: the spawn moment is the
     * authoritative observation, so it may replace a stale record for a number the
     * OS reused (a new child just took it), but there is no second read of the
     * same spawn that could replace that observation — least of all an unreadable
     * one with a readable one (review 5723412625).
     */
    recordOwnSpawn(pid: number): this {
      spawnedIdentities.set(pid, readStartIdentity(pid));
      return super.add(pid);
    }
  }
  const spawnedPids = new SpawnedPidSet();
  /**
   * Every bridge this file created through trackedBridge. A cancelled or
   * failed test leaves its bridge's in-flight work running in the background;
   * the guard closes every tracked bridge before its sweep, so a body that
   * keeps running after cancellation can never spawn a service the sweep has
   * already passed over (the 2026-10-15 milestone escapee).
   */
  const trackedBridges = new Set<ServiceBridge>();
  /**
   * Every service pid this file ever observed, never cleared: the file-level
   * guard asserts each one is settled at the end. Only this file's own pids are
   * ever tracked — sibling test files run concurrently in their own
   * processes, so a shared argv scan would mistake their live services for
   * this file's leaks.
   */
  const observedPids = new Set<number>();
  /**
   * Targets a teardown could not prove settled, kept across calls. The sweep
   * removes each service's identity file, so memory is the only place a failed
   * target survives; losing it would let the next teardown report clean without
   * re-proving the process and group this file started (review 5722842535).
   */
  const retainedTargets = new Set<number>();

  /** Old-backend-shaped fake adapter for the first-cutover fixture. */
  function fakeAdapter(dir: string): Adapter {
    return {
      client: { isConnected: true }, hostId: 'fixture-host',
      socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'worker-helper.mjs'),
      connect: async () => {}, close: async () => {}, profiles: async () => [],
      observe: async () => ({ id: 'w', workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }),
    } as unknown as Adapter;
  }

  function serviceCommand() {
    return { command: process.execPath, args: ['--import', 'tsx', fileURLToPath(new URL('../../bin/queue-service.mjs', import.meta.url))] };
  }

  /**
   * A bridge the file-level guard owns. Its spawned services join spawnedPids
   * at the moment of spawn (before any identity file exists), and the guard
   * closes the bridge before sweeping, so post-sweep spawns are impossible.
   * The options object is passed through by reference, not copied: tests tune
   * a live options object between calls and the bridge reads it lazily.
   */
  function trackedBridge(options: Partial<ConstructorParameters<typeof ServiceBridge>[0]> = {}): ServiceBridge {
    const previous = options.onSpawn;
    options.onSpawn = pid => { spawnedPids.recordOwnSpawn(pid); previous?.(pid); };
    const bridge = new ServiceBridge({ processActions: bridgeProcessActions, ...options });
    trackedBridges.add(bridge);
    return bridge;
  }

  async function bridgeFixture(): Promise<{ bridge: ServiceBridge; dataDir: string; paseoHome: string; root: string }> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    const paseoHome = root, dataDir = join(root, 'northstar-queue');
    mkdirSync(paseoHome, { recursive: true, mode: 0o700 });
    // The spawned service and bridge both use this checkout's source root.
    writeFileSync(join(paseoHome, 'config.json'), JSON.stringify({ plugins: { nucleus: { path: fileURLToPath(new URL('../..', import.meta.url)) } } }), { mode: 0o600 });
    // Tracked like every other fixture bridge: a service this bridge starts is
    // owned by the file's spawn record, and teardown can close its admission
    // (review 5722890385). An untracked fixture bridge left its services to be
    // discovered from an identity file, which is not ownership.
    const bridge = trackedBridge({ dataDir, paseoHome, serviceCommand, readinessBudgetMs: 60_000 });
    return { bridge, dataDir, paseoHome, root };
  }

  /**
   * The live process group this pid belongs to and whether it is a reaped-but-
   * uncollected zombie, in one host read. Null when this host cannot say: an
   * unreadable process is `unknown`, never a different process.
   */
  function liveProcessState(pid: number): { zombie: boolean; groupId: number } | null {
    if (process.platform === 'linux') {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const groupId = Number(fields[2]);
        if (!Number.isInteger(groupId) || groupId <= 0) return null;
        return { zombie: fields[0] === 'Z', groupId };
      } catch { return null; }
    }
    try {
      const result = spawnSync('ps', ['-o', 'stat=,pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
      const match = /^\s*(\S+)\s+(\d+)\s*$/.exec(result.stdout ?? '');
      if (result.status !== 0 || !match) return null;
      const groupId = Number(match[2]);
      if (!Number.isInteger(groupId) || groupId <= 0) return null;
      return { zombie: match[1].startsWith('Z'), groupId };
    } catch { return null; }
  }

  /**
   * Ownership proof for one pid this file may have to settle. A fixture-owned
   * service is `ours` while its recorded start identity still matches and it
   * still leads its own detached group; anything else is `foreign` (a recycled
   * number or another process) or `unknown`. The command line is read only for
   * a pid this file adopted rather than spawned: a wrapper's argv is not
   * ownership and never decides this file's own spawns.
   */
  /**
   * The pid's liveness; `unknown` is never treated as gone and never as settled.
   * A process this host cannot signal proves nothing either way.
   */
  function pidLiveness(pid: number): "alive" | "gone" | "unknown" {
    return processLiveness(pid);
  }

  function serviceProof(pid: number): ServiceProof {
    if (!Number.isInteger(pid) || pid <= 0) return "unknown";
    const liveness = pidLiveness(pid);
    if (liveness === "gone") return "gone";
    if (liveness === "unknown") return "unknown";
    const live = liveProcessState(pid);
    const spawned = spawnedIdentities.has(pid);
    return serviceOwnershipVerdict({
      alive: true,
      zombie: live?.zombie ?? false,
      pid,
      spawned,
      recordedIdentity: spawned ? spawnedIdentities.get(pid) ?? null : null,
      liveIdentity: spawned ? readStartIdentity(pid) : null,
      groupId: live?.groupId ?? null,
    });
  }

  /**
   * Whether the detached group a fixture-owned service led is empty, or null when
   * this pid never led one. Only a recorded spawn has that obligation: a pid this
   * file did not spawn is never signalled and is reported `unknown`, so it can
   * never be called settled behind a live group either.
   */
  function ownedGroupEmpty(pid: number): boolean | null {
    if (!spawnedIdentities.has(pid)) return null;
    return processGroupEmpty(pid);
  }

  /**
   * Stop one service's whole process group. Bridge-spawned services are
   * detached group leaders, so signalling the group stops the service and any
   * child it forked; a pid that no longer names our service — or whose identity
   * this host cannot read — is never signalled.
   */
  function stopServiceGroup(pid: number, signal: NodeJS.Signals): boolean {
    if (serviceProof(pid) !== "ours") return false;
    try { process.kill(-pid, signal); return true; }
    catch { return false; }
  }

  /**
   * Wait until every target is proved not to be this file's live service and the
   * group it led is empty. Only a killed or exited process and an empty group
   * are proof; elapsed time never is, which is why this is bounded and reports
   * what it could not prove rather than assuming it.
   */
  async function waitForExit(targets: Set<number>, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const pending = [...targets].filter(pid => {
        const proof = serviceProof(pid);
        if (proof === "ours" || proof === "unknown") return true;
        return proof === "gone" && ownedGroupEmpty(pid) === false;
      });
      if (!pending.length) return;
      await sleep(100);
    }
  }

  /**
   * Let every tracked bridge's in-flight work settle, up to the deadline. This is
   * the write the fixture used to leave running: a spawn's readiness wait
   * refreshes its claim and clears markers, and writes the startup-failure
   * record when its child exits, all after `close()` returned (review
   * 5723080357).
   */
  async function drainBridgeWork(deadline: number): Promise<boolean> {
    const pending = () => [...trackedBridges].flatMap(bridge => bridgeInFlightWork(bridge));
    while (pending().length && Date.now() < deadline) {
      const wait = Math.max(0, deadline - Date.now());
      await Promise.race([Promise.all(pending().map(promise => promise.catch(() => null))), sleep(wait)]);
    }
    return pending().length === 0;
  }

  /**
   * Settle every service this file owns and prove it, and let the bridges' own
   * in-flight work settle first. Admission closes before anything else (every
   * tracked bridge is closed), then the sweep drains each service group
   * (SIGTERM), kills what is still proved ours (SIGKILL), and waits for the
   * bridge waits that were writing to the directory to finish. A wait that made
   * a late spawn is swept by the next round; each round is bounded by the same
   * deadline. Nothing here depends on a wrapper's argv: the spawn record owns the
   * process.
   *
   * A target that cannot be proved settled stays a target. Release would be the
   * only record of it — the identity files are removed here so a swept service
   * reports no owner — and dropping it let a later teardown return an empty,
   * apparently clean report while the owned process or its group was still
   * alive (review 5722842535).
   */
  async function settleServices(): Promise<{ settlements: ServiceSettlement[]; bridgeWorkSettled: boolean }> {
    for (const bridge of trackedBridges) bridge.close();
    const deadline = Date.now() + teardownWaitMs;
    const targets = new Set<number>();
    // Spawned children are detached; their identity files name their pid. Walk
    // every temp dir created by this file's prefix, prefer the recorded spawns,
    // and leave a pid this file did not spawn reported but never signalled.
    const discover = () => {
      for (const pid of spawnedPids) targets.add(pid);
      for (const pid of retainedTargets) targets.add(pid);
      for (const name of readdirSync(tmpdir())) {
        if (!name.startsWith(prefix)) continue;
        const dir = join(tmpdir(), name, 'northstar-queue');
        try {
          const info = JSON.parse(readFileSync(join(dir, 'queue-service.json'), 'utf8')) as { pid: number };
          if (info.pid !== process.pid) targets.add(info.pid);
          rmSync(join(dir, 'queue-service.sock'), { force: true });
          rmSync(join(dir, 'queue-service.json'), { force: true });
        } catch {}
      }
      for (const pid of targets) observedPids.add(pid);
      return targets;
    };
    discover();
    let bridgeWorkSettled = false;
    for (let round = 0; round < 3; round += 1) {
      const before = targets.size;
      for (const pid of targets) stopServiceGroup(pid, 'SIGTERM');
      await waitForExit(targets, deadline);
      for (const pid of targets) { if (serviceProof(pid) === "ours") stopServiceGroup(pid, 'SIGKILL'); }
      await waitForExit(targets, deadline);
      // The exit ends any readiness wait; letting it settle also surfaces a spawn
      // that wait made before it gave up, which the next round sweeps.
      bridgeWorkSettled = await drainBridgeWork(deadline);
      discover();
      if (targets.size === before && bridgeWorkSettled) break;
    }
    const settlements = [...targets].map(pid => {
      const proof = serviceProof(pid);
      // A group is only this service's own while the pid still names it: a
      // recycled number now leads someone else's group and says nothing.
      return { pid, proof, groupEmpty: proof === "gone" || proof === "ours" ? ownedGroupEmpty(pid) : null };
    });
    // Only a proved settlement releases a target; anything still ours, unknown
    // or holding its own non-empty group is swept and reported again next time.
    for (const settlement of settlements) {
      if (settlementUnproved(settlement)) retainedTargets.add(settlement.pid);
      else { retainedTargets.delete(settlement.pid); spawnedPids.delete(settlement.pid); }
    }
    return { settlements, bridgeWorkSettled };
  }

  /** A settlement this file cannot call clean: still ours, unknown, or a group of its own that is not empty. */
  function settlementUnproved(settlement: ServiceSettlement): boolean {
    return settlement.proof === "ours" || settlement.proof === "unknown" || settlement.groupEmpty === false;
  }

  /**
   * Settle this file's fixture services, let their bridge work finish, and prove
   * it. A service still proved ours, a pid whose identity this host could not
   * read, a pid this file never spawned, or bridge work still writing to the
   * directory is not a clean teardown: this throws instead of letting the caller
   * dispose a directory a live writer may still own (the milestone's ENOTEMPTY
   * shape), and the target stays swept by the next call.
   */
  async function killServices(): Promise<ServiceSettlement[]> {
    const { settlements, bridgeWorkSettled } = await settleServices();
    const unsettled = settlements.filter(settlementUnproved);
    if (!bridgeWorkSettled || unsettled.length) {
      const work = bridgeWorkSettled ? "" : " in-flight bridge work did not settle (a spawn readiness wait, claim refresh, marker clear or startup-failure write may still run);";
      throw new Error(`fixture teardown could not prove ${unsettled.length} service(s) exited:${work} ${unsettled.map(settlement =>
        `pid ${settlement.pid} proof ${settlement.proof}${settlement.groupEmpty === null ? "" : ` group empty ${settlement.groupEmpty}`} ${processCommandLine(settlement.pid) ?? ""}`.slice(0, 300)).join("; ")}`);
    }
    return settlements;
  }

  // Task 191 guard: stop this file's own services on every path — including a
  // failure or timeout that skipped a test's own finally — then prove none of
  // the pids this file observed survived. Scoped strictly to observed pids:
  // sibling files share this checkout's argv under --test-concurrency=6, so a
  // shared process scan could SIGKILL their live services. The hook registers
  // on the importing test file, where bridgeSupport() runs at the top level;
  // outside a test file it is skipped.
  try {
    after(async () => {
      await killServices();
      const survivors = [...observedPids].filter(pid => {
        const proof = serviceProof(pid);
        return proof === "ours" || proof === "unknown";
      });
      assert.equal(survivors.length, 0,
        `leaked queue-service processes from this test file: ${survivors.map(pid => `pid ${pid} ${serviceProof(pid)} ${processCommandLine(pid) ?? ""}`.slice(0, 300)).join("; ")}`);
    });
  } catch { /* Imported outside a test file: per-test finally blocks still apply. */ }

  /**
   * Dispose one fixture's disposable root, but only after the guard has proved
   * every service this file owns and the bridge work it left running have
   * settled. `killServices` throws when it cannot, and the directory then stays:
   * a removal in a `finally` that ignored an unproved teardown would dispose the
   * directory behind the very process it could not rule out (review 5723236447).
   */
  async function dispose(root: string): Promise<void> {
    await killServices();
    rmSync(root, { recursive: true, force: true });
  }

  function pidAliveNumber(pid: number): boolean {
    return pidLiveness(pid) !== "gone";
  }

  function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
  return { spawnedPids, fakeAdapter, serviceCommand, trackedBridge, bridgeFixture, killServices, dispose, serviceProof, ownedGroupEmpty, pidAliveNumber, sleep };
}
