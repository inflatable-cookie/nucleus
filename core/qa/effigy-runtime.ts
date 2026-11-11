/**
 * The Effigy runtime identity Queue trusts for admission and run-control
 * (Spec 035, "Runtime identity").
 *
 * Effigy runs the admitted heavy workload and writes the run journal Queue
 * later reads to settle that run's capacity. The executable that reads the
 * journal must be the one that ran the workload, never whatever a mutable
 * service PATH resolves. Queue no longer pins one declared build by its bytes
 * (Tom, 2026-10-26: "pinning an exact version means any change on my dev
 * version of effigy forces a change in Queue, and effigy will change a lot").
 * It trusts the Effigy that actually launched the workload, found from the
 * admission hook's attested process ancestry, records that executable's path,
 * version and bytes with the run, and observes the run with that same
 * executable. An optional operator floor (`effigyRuntime.minVersion`) refuses
 * admission to an older Effigy.
 *
 * Nothing here resolves a name through PATH and no caller-supplied executable
 * becomes authority: the hook attests a pid, and the service reads that pid's
 * own image. A workload with no identifiable Effigy ancestor binds nothing; an
 * unbound reservation is never observed and keeps its capacity visibly held.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { digestEffigyExecutable, type EffigyExecutableDigest } from "./effigy-artifact-digest";
import { processExecutablePath, processParentPid } from "../machine/process-identity";
import { hostRunProcessStartIdentity, startIdentityMatches } from "../machine/start-identity";

export {
  DIGEST_READ_ATTEMPTS,
  ExecutableDigestCache,
  digestEffigyExecutable,
  effigyArtifactDigests,
  type EffigyExecutableDigest,
  type ExecutableDigestCost,
  type ExecutableFileIdentity,
} from "./effigy-artifact-digest";

/** Bounded ancestor walk: the hook, then the Effigy that spawned it, then its own wrappers. */
export const EFFIGY_RUNTIME_ANCESTOR_LIMIT = 4;

/** `major.minor.patch`; build metadata and pre-release tags are not part of the floor. */
const versionFloorSchema = z.string().trim().regex(/^\d+\.\d+\.\d+$/, "Effigy minVersion must be major.minor.patch");
/**
 * Host settings `effigyRuntime`. Only `minVersion` has meaning. The retired
 * `{ path, sha256 }` exact-bytes pin is still accepted so an older settings file
 * keeps the service starting, and is ignored (Spec 035, Tom 2026-10-26).
 */
export const effigyRuntimeSettingsSchema = z.object({
  minVersion: versionFloorSchema.optional(),
  /** Retired: the exact-bytes pin. Accepted and ignored. */
  path: z.string().optional(),
  /** Retired: the exact-bytes pin. Accepted and ignored. */
  sha256: z.string().optional(),
}).strict();
export type EffigyRuntimeSettings = z.infer<typeof effigyRuntimeSettingsSchema>;
/** The executable Queue runs and binds: the workload's own Effigy, with its bytes recorded as provenance. */
export interface EffigyRuntimeIdentity {
  path: string;
  sha256: string;
}
export interface EffigyVersion { major: number; minor: number; patch: number; text: string }
/** Parse `effigy vX.Y.Z[+meta]` from a `--version` answer; anything else is not Effigy. */
export function parseEffigyVersion(output: string): EffigyVersion | null {
  const match = /^effigy v(\d+)\.(\d+)\.(\d+)(\S*)/m.exec(output.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: `${match[1]}.${match[2]}.${match[3]}${match[4]}` };
}
/** Whether `version` is at least the `major.minor.patch` floor; build metadata is ignored. */
export function meetsEffigyVersionFloor(version: EffigyVersion, floor: string): boolean {
  const [major, minor, patch] = floor.split(".").map(Number) as [number, number, number];
  if (version.major !== major) return version.major > major;
  if (version.minor !== minor) return version.minor > minor;
  return version.patch >= patch;
}
/** How long one `--version` question may take before it counts as no answer. */
export const EFFIGY_VERSION_PROBE_TIMEOUT_MS = 5_000;
/** Bound on remembered version answers; least recently used is evicted. */
export const EFFIGY_VERSION_CACHE_LIMIT = 32;

/** One bounded `<image> --version` call by absolute path: no shell, no PATH, `EFFIGY_LAUNCH` cleared. */
function askVersion(path: string, timeoutMs: number): Promise<{ answered: true; stdout: string } | { answered: false }> {
  return new Promise(resolve => {
    execFile(path, ["--version"], {
      timeout: timeoutMs, encoding: "utf8", shell: false, windowsHide: true,
      env: { ...process.env, EFFIGY_LAUNCH: undefined },
    }, (error, stdout) => resolve(error ? { answered: false } : { answered: true, stdout: String(stdout ?? "") }));
  });
}

/**
 * Asks an executable image which Effigy it is, without stalling the service
 * (Spec 035, "Runtime identity"). The call is asynchronous and bounded; an
 * answer is remembered per image identity (path, size, mtime and inode from one
 * `stat`), so repeated admissions on the same binary spawn nothing, and a
 * rebuild changes the identity and asks again. Concurrent questions about one
 * identity share one call. A call that fails or times out is not remembered.
 */
export class EffigyVersionProbe {
  private readonly answers = new Map<string, EffigyVersion | null>();
  private readonly pending = new Map<string, Promise<EffigyVersion | null>>();
  /** Real `--version` calls made, for cost tests. */
  calls = 0;

  constructor(private readonly options: {
    ask?: (path: string, timeoutMs: number) => Promise<{ answered: true; stdout: string } | { answered: false }>;
    timeoutMs?: number;
    limit?: number;
  } = {}) {}

  async version(path: string): Promise<EffigyVersion | null> {
    if (!isAbsolute(path)) return null;
    let key: string;
    try {
      const info = await stat(path);
      key = `${path}\u0000${info.size}\u0000${info.mtimeMs}\u0000${info.ino}`;
    } catch { return null; }
    if (this.answers.has(key)) {
      const answer = this.answers.get(key)!;
      this.answers.delete(key);
      this.answers.set(key, answer);
      return answer;
    }
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const call = (async () => {
      this.calls++;
      const result = await (this.options.ask ?? askVersion)(path, this.options.timeoutMs ?? EFFIGY_VERSION_PROBE_TIMEOUT_MS);
      if (!result.answered) return null;
      const answer = parseEffigyVersion(result.stdout);
      this.answers.set(key, answer);
      const limit = this.options.limit ?? EFFIGY_VERSION_CACHE_LIMIT;
      while (this.answers.size > limit) this.answers.delete(this.answers.keys().next().value!);
      return answer;
    })().finally(() => { this.pending.delete(key); });
    this.pending.set(key, call);
    return call;
  }
}

/** The service's one probe. */
export const effigyVersionProbe = new EffigyVersionProbe();
/** Ask an absolute executable path for its Effigy version: asynchronous, bounded and cached per image identity. */
export function probeEffigyVersion(path: string): Promise<EffigyVersion | null> {
  return effigyVersionProbe.version(path);
}

/** One ancestor of the admission hook, as the hook attested it. */
export interface EffigyRuntimeAncestor {
  pid: number;
  startIdentity: string;
}

export type EffigyRuntimeVerification =
  | { kind: "verified"; identity: EffigyRuntimeIdentity }
  /** The executable cannot be run right now: missing, unreadable or not an executable file. */
  | { kind: "unavailable"; reason: string }
  /** It still runs, but its bytes are not the bytes recorded at binding (rebuilt in place). */
  | { kind: "drift"; reason: string; identity: EffigyRuntimeIdentity };

export type EffigyRuntimeBinding =
  | {
    kind: "bound";
    /** The workload's own Effigy executable the observer runs, with its bytes at binding. */
    identity: EffigyRuntimeIdentity;
    /** Its `--version`, e.g. `0.14.1+local.9adacdd`. */
    version: string;
    /** The executable image the admitted workload process was running. */
    workloadPath: string;
    workloadPid: number;
    workloadStartIdentity: string;
  }
  | { kind: "unbound"; reason: string };

export interface BindEffigyRuntimeInput {
  settings: EffigyRuntimeSettings | null | undefined;
  /** Ancestors from the hook's parent upwards, attested by the hook. */
  ancestry: readonly EffigyRuntimeAncestor[];
  /** Test seams; production reads the host, hashes real bytes and asks the image itself. */
  digest?: (path: string) => Promise<EffigyExecutableDigest>;
  executablePath?: (pid: number) => string | null;
  liveStartIdentity?: (pid: number) => string;
  probeVersion?: (path: string) => EffigyVersion | null | Promise<EffigyVersion | null>;
}

/**
 * Re-read the bound executable before an observation. Only an executable that
 * cannot run is a refusal. Bytes that changed since binding (Effigy rebuilt in
 * place) are reported as drift for provenance and the call still runs: the same
 * path is still the workload's own Effigy (Spec 035, Tom 2026-10-26).
 */
export async function verifyEffigyRuntime(
  runtime: EffigyRuntimeIdentity,
  digest: (path: string) => Promise<EffigyExecutableDigest> = digestEffigyExecutable,
): Promise<EffigyRuntimeVerification> {
  const current = await digest(runtime.path);
  if (current.kind === "missing" || current.kind === "unreadable")
    return { kind: "unavailable", reason: current.reason };
  if (current.kind === "not-executable") return { kind: "unavailable", reason: current.reason };
  const identity = { path: current.path, sha256: current.sha256 };
  if (current.sha256 !== runtime.sha256)
    return { kind: "drift", identity, reason: `${current.path} now hashes ${current.sha256}, bound ${runtime.sha256}` };
  return { kind: "verified", identity };
}

/**
 * Bind the Effigy that launched the workload to one admission reservation, or
 * refuse with a concrete reason. Each live attested ancestor's image is asked
 * for its version by absolute path; the first that answers as Effigy is the
 * workload's runtime. A stale or recycled ancestor is skipped, never trusted, and
 * a configured `minVersion` refuses an older Effigy.
 */
export async function bindEffigyRuntime(input: BindEffigyRuntimeInput): Promise<EffigyRuntimeBinding> {
  const ancestry = input.ancestry.slice(0, EFFIGY_RUNTIME_ANCESTOR_LIMIT);
  if (!ancestry.length) return { kind: "unbound", reason: "the admission hook attested no ancestor process" };
  const digest = input.digest ?? digestEffigyExecutable;
  const executablePath = input.executablePath ?? processExecutablePath;
  const liveStartIdentity = input.liveStartIdentity ?? (pid => hostRunProcessStartIdentity(pid));
  const probeVersion = input.probeVersion ?? probeEffigyVersion;
  const floor = input.settings?.minVersion;
  const rejected: string[] = [];
  for (const ancestor of ancestry) {
    if (!Number.isInteger(ancestor.pid) || ancestor.pid <= 0) continue;
    const live = liveStartIdentity(ancestor.pid);
    if (live.endsWith("@unknown") || !startIdentityMatches(ancestor.startIdentity, live)) {
      rejected.push(`pid ${ancestor.pid} is gone or reused`);
      continue;
    }
    const imagePath = executablePath(ancestor.pid);
    if (!imagePath) {
      rejected.push(`pid ${ancestor.pid} has no readable executable image`);
      continue;
    }
    const workload = await digest(imagePath);
    if (workload.kind !== "ok") {
      rejected.push(`pid ${ancestor.pid} image ${workload.reason}`);
      continue;
    }
    const version = await probeVersion(workload.path);
    if (!version) {
      rejected.push(`pid ${ancestor.pid} runs ${workload.path}, which does not answer as Effigy`);
      continue;
    }
    if (floor && !meetsEffigyVersionFloor(version, floor))
      return { kind: "unbound", reason: `the workload runs Effigy ${version.text} (${workload.path}), below the configured minimum ${floor}` };
    return {
      kind: "bound",
      identity: { path: workload.path, sha256: workload.sha256 },
      version: version.text,
      workloadPath: workload.path,
      workloadPid: ancestor.pid,
      workloadStartIdentity: ancestor.startIdentity,
    };
  }
  return { kind: "unbound", reason: `the admitted workload has no identifiable Effigy ancestor; ${rejected.join("; ") || "no live ancestor"}` };
}

/**
 * The ancestry an admission hook attests: its own parent upwards, with each
 * process's contract 010 start identity so the service can tell a live image
 * from a recycled pid before it reads that image.
 */
export function admissionAncestry(
  startPid: number = process.ppid,
  depth: number = EFFIGY_RUNTIME_ANCESTOR_LIMIT,
): EffigyRuntimeAncestor[] {
  const ancestry: EffigyRuntimeAncestor[] = [];
  const seen = new Set<number>();
  let pid = startPid;
  while (pid > 1 && ancestry.length < depth && !seen.has(pid)) {
    seen.add(pid);
    ancestry.push({ pid, startIdentity: hostRunProcessStartIdentity(pid) });
    pid = processParentPid(pid) ?? 0;
  }
  return ancestry;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
