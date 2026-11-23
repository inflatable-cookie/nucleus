import type { HostProcessFact } from "../host/types";
import { pidAlive } from "./pid";
import {
  processStartIdentityLivenessAsync,
  type ProcessStartIdentityLiveness,
} from "./process-identity-search";
import { startIdentityProves } from "./start-identity";
import {
  runProcessActivity,
  participantRuntimePids,
  providerRuntimePids,
} from "./run-process-tree";
import type { ParticipantRuntime } from "./participant-runtime";

/**
 * Spec 068 §4 hung tools: the one command a participant's tool call is running,
 * found in its provider's process tree and stopped by its own process identity.
 *
 * The target is never the provider, its Nucleus report helper or its standing
 * tool runtimes, so the agent's turn survives and sees a failed tool call. Every
 * signal is preceded by a start-identity read of the exact process (or group
 * leader) it addresses: a reused pid with a different birth is never signalled.
 */

/** One process the termination may signal, with the birth identity it was selected under. */
export interface HungToolMember {
  pid: number;
  startIdentity: string;
}

export interface HungToolTarget {
  /** `group`: the command leads its own process group, so the group is signalled. `tree`: each member is signalled by pid. */
  kind: "group" | "tree";
  providerPid: number;
  root: HungToolMember & { pgid: number; command: string };
  members: HungToolMember[];
}

export type HungToolSelection =
  | { target: HungToolTarget }
  | { refusal: string };

export interface HungToolTermination {
  outcome: "terminated" | "identity_changed" | "survived";
  /** Pids sent SIGTERM (or covered by the group SIGTERM). */
  signalled: number[];
  /** Pids sent SIGKILL after the grace. */
  killed: number[];
  /** Members still alive under their recorded identity after SIGKILL. */
  survivors: number[];
}

export interface HungToolSignals {
  graceMs?: number;
  liveness?: (pid: number, startIdentity: string) => Promise<ProcessStartIdentityLiveness>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
}

/** The SIGTERM grace before SIGKILL: long enough for a test runner to flush and exit. */
export const HUNG_TOOL_GRACE_MS = 5_000;

const normalized = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The part of a command line every shell wrapper keeps verbatim: the text before
 * its first quote, escape or line break, since providers re-quote the rest.
 */
export function commandNeedle(command: string): string | null {
  const head = normalized(command.split(/["'`\\\r\n]/, 1)[0] ?? "");
  return head.length >= 3 ? head : null;
}

function zombie(process: HostProcessFact): boolean {
  return process.state?.toUpperCase().startsWith("Z") ?? false;
}

function subtree(rootPid: number, processes: readonly HostProcessFact[]): Set<number> {
  const tree = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes)
      if (process.ppid != null && tree.has(process.ppid) && !tree.has(process.pid)) {
        tree.add(process.pid);
        changed = true;
      }
  }
  return tree;
}

/**
 * The hung command for one run: its provider is the parent of the run's own MCP
 * report helper, and the command is the topmost process under that provider
 * whose command line carries the tool's command. Anything other than exactly one
 * such process is refused, so an ambiguous or unreadable tree stops nothing.
 */
export function selectHungTool(
  runId: string,
  command: string,
  processes: readonly HostProcessFact[] | null,
  runtime: ParticipantRuntime = {},
): HungToolSelection {
  const needle = commandNeedle(command);
  if (!needle) return { refusal: "the tool's command line is too short to identify its process" };
  if (!processes) return { refusal: "the host process listing is unreadable" };
  const live = processes.filter((process) => !zombie(process));
  const verdict = runProcessActivity(runId, live);
  if (verdict.state === "unknown") return { refusal: verdict.reason };
  const byPid = new Map(live.map((process) => [process.pid, process]));
  const provider = byPid.get(verdict.providerPid);
  if (!provider) return { refusal: "the provider process is not in the listing" };
  const excluded = subtree(verdict.helperPid, live);
  excluded.add(provider.pid);
  for (const pid of providerRuntimePids(provider, live)) excluded.add(pid);
  for (const pid of participantRuntimePids(live, runtime)) excluded.add(pid);
  const descendants = subtree(provider.pid, live);
  descendants.delete(provider.pid);
  const matches = (process: HostProcessFact | undefined): process is HostProcessFact =>
    Boolean(process && descendants.has(process.pid) && !excluded.has(process.pid) &&
      !process.protectedRuntime && normalized(process.command).includes(needle));
  const roots = new Map<number, HostProcessFact>();
  for (const process of live) {
    if (!matches(process)) continue;
    let root = process;
    for (let parent = byPid.get(root.ppid ?? -1); matches(parent); parent = byPid.get(root.ppid ?? -1))
      root = parent;
    roots.set(root.pid, root);
  }
  if (roots.size !== 1)
    return { refusal: roots.size ? `${roots.size} processes under the provider match the command` : "no process under the provider matches the command" };
  const root = [...roots.values()][0]!;
  if (!startIdentityProves(root.startIdentity))
    return { refusal: `pid ${root.pid} has no readable start identity` };
  const tree = subtree(root.pid, live);
  const members = live
    .filter((process) => tree.has(process.pid) && !excluded.has(process.pid) && !process.protectedRuntime &&
      startIdentityProves(process.startIdentity))
    .map(({ pid, startIdentity }) => ({ pid, startIdentity }));
  // The command owns its group only when it leads a group apart from the
  // provider's and every listed member of that group is inside its own tree.
  const ownGroup = root.pgid === root.pid && root.pgid !== provider.pgid &&
    live.every((process) => process.pgid !== root.pgid || tree.has(process.pid));
  return {
    target: {
      kind: ownGroup ? "group" : "tree",
      providerPid: provider.pid,
      root: { pid: root.pid, startIdentity: root.startIdentity, pgid: root.pgid, command: root.command },
      members,
    },
  };
}

const defaultSignal = (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal);

function send(signal: NonNullable<HungToolSignals["signal"]>, pid: number, name: NodeJS.Signals): boolean {
  try {
    signal(pid, name);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "ESRCH" || code === "EPERM") return false;
    throw error;
  }
}

/**
 * SIGTERM the command, wait the grace, then SIGKILL whatever still carries its
 * recorded identity. A group is addressed only while its leader proves its birth
 * identity; each pid only while that pid does.
 */
export async function terminateHungTool(target: HungToolTarget, options: HungToolSignals = {}): Promise<HungToolTermination> {
  const liveness = options.liveness ?? processStartIdentityLivenessAsync;
  const signal = options.signal ?? defaultSignal;
  const graceMs = options.graceMs ?? HUNG_TOOL_GRACE_MS;
  const alive = async (member: HungToolMember) => (await liveness(member.pid, member.startIdentity)) === "alive";
  const result: HungToolTermination = { outcome: "terminated", signalled: [], killed: [], survivors: [] };
  if (!(await alive(target.root))) return { ...result, outcome: "identity_changed" };
  const members = target.members.some((member) => member.pid === target.root.pid)
    ? target.members
    : [{ pid: target.root.pid, startIdentity: target.root.startIdentity }, ...target.members];
  const deliver = async (name: NodeJS.Signals): Promise<number[]> => {
    const sent: number[] = [];
    if (target.kind === "group" && (await alive(target.root)) && send(signal, -target.root.pgid, name))
      sent.push(...members.map((member) => member.pid));
    for (const member of members) {
      if (sent.includes(member.pid) || !(await alive(member))) continue;
      if (send(signal, member.pid, name)) sent.push(member.pid);
    }
    return sent;
  };
  result.signalled = await deliver("SIGTERM");
  const living = async () => {
    const left: HungToolMember[] = [];
    for (const member of members) if (pidAlive(member.pid) && (await alive(member))) left.push(member);
    return left;
  };
  const deadline = Date.now() + graceMs;
  let left = await living();
  while (left.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
    left = await living();
  }
  if (left.length) {
    if (target.kind === "group" && (await alive(target.root)) && send(signal, -target.root.pgid, "SIGKILL"))
      result.killed.push(target.root.pid);
    for (const member of left) if ((await alive(member)) && send(signal, member.pid, "SIGKILL")) result.killed.push(member.pid);
    const settle = Date.now() + 1_000;
    while ((left = await living()).length && Date.now() < settle)
      await new Promise((resolve) => setTimeout(resolve, 50));
  }
  result.survivors = left.map((member) => member.pid);
  return { ...result, outcome: result.survivors.length ? "survived" : "terminated" };
}
