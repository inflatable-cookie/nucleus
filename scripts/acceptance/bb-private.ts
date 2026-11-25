/** Isolation and process helpers for the private BB board proof. */
import { spawn, type ChildProcess } from "node:child_process";
import { openSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { createServer, connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { bbInstallFromCli, findBbCli } from "../../shared/bb-cli.mjs";

export interface IsolationInput {
  /** The data directory this run would use. */
  requested: string;
  /** The operator's live BB data directory. */
  live: string;
  /** The scratch root this run owns. */
  proofRoot: string;
}

/** A refusal names the path it compared, with the account home shortened to `~`. */
function displayPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/**
 * Refuse any data directory that is, contains, or sits inside the operator's live BB
 * data directory, and refuse one outside this run's own scratch root. The refusal
 * names both paths it compared, so a reader sees exactly what was tried.
 */
export function assertIsolatedDataDir(input: IsolationInput): { ok: true } | { ok: false; reason: string } {
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const requested = real(input.requested);
  const live = real(input.live);
  const proofRoot = real(input.proofRoot);
  const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
  if (inside(requested, live) || inside(live, requested)) {
    return { ok: false, reason: `refusing to run against the operator's live BB data directory (${displayPath(input.live)}); this proof uses an isolated data directory of its own` };
  }
  if (!inside(requested, proofRoot)) {
    return { ok: false, reason: `refusing a BB data directory outside this run's scratch root (${displayPath(input.requested)} is not inside ${displayPath(input.proofRoot)})` };
  }
  return { ok: true };
}

export interface BbInstall { cli: string; serverLauncher: string; daemonLauncher: string }

/** Find the installed BB from its own command shim; report every path tried when it is absent. */
export function findBb(override: string | null): { install: BbInstall } | { install: null; tried: string[] } {
  // One owner for the shim list and the app layout: `shared/bb-cli.mjs` (phase 7's
  // `nucleus bb install` reads the same list, so a proof and an operator install
  // can never disagree about which BB they mean).
  let found: { install: BbInstall | null; tried: string[] };
  if (override) found = bbInstallFromCli(override);
  else {
    const { cli, tried } = findBbCli();
    found = cli ? bbInstallFromCli(cli) : { install: null, tried };
  }
  return found.install
    ? { install: found.install }
    : { install: null, tried: found.tried };
}

export async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePort(port));
    });
  });
}

export async function portOpen(port: number): Promise<boolean> {
  return await new Promise(resolveOpen => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(500, () => { socket.destroy(); resolveOpen(false); });
    socket.on("connect", () => { socket.destroy(); resolveOpen(true); });
    socket.on("error", () => resolveOpen(false));
  });
}

export async function waitFor<T>(what: string, probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
}

export interface Child { child: ChildProcess; label: string }

export function startProcess(label: string, command: string, argv: string[], env: NodeJS.ProcessEnv, logPath: string): Child {
  const log = openSync(logPath, "a");
  // Detached so this file owns the process group it created: teardown signals that
  // group and nothing else, never a pattern.
  const child = spawn(command, argv, { env, stdio: ["ignore", log, log], detached: true });
  child.unref();
  return { child, label };
}

/** Stop a process this file started, and its own process group. */
export async function stopProcess(entry: Child | null): Promise<void> {
  if (!entry) return;
  const pid = entry.child.pid;
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGTERM"); } catch { try { entry.child.kill("SIGTERM"); } catch { /* already gone */ } }
  const exited = await Promise.race([
    new Promise<boolean>(resolveExit => entry.child.once("exit", () => resolveExit(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    await delay(200);
  }
}
