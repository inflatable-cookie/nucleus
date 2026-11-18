/**
 * The roll step that keeps BB's installed Nucleus plugin on the build the roll
 * landed (nucleus#1339).
 *
 * Twice on 2026-11-18 a service roll left BB's installed plugin at the previous
 * build: its build pin refused the plugin, the BB host went offline and BB tasks
 * stalled until a planner ran `nucleus bb install` by hand. This step closes that
 * gap without a second install route: it runs the activated version's own
 * `nucleus bb status`, and only when BB reports the installed plugin as `behind`
 * it runs that same package's `nucleus bb install`. The route is unchanged —
 * including the owner-writable managed copy #1319 built, so nothing writes into the
 * installed version directory — and a BB update's own rebuild of that copy's bundle
 * changes nothing this step reads (nucleus#1348).
 *
 * Three rules decide what it does:
 *
 * - a machine whose BB has no plugin with ID `nucleus` (`not-installed`) is
 *   untouched, and so is a BB this host cannot run or read: no BB, no step;
 * - a plugin that is not this integration's (`unrecognised`, `unpinned` — a
 *   namesake or a developer's checkout install) is left alone: the route refuses
 *   it, and the pin's own message already names `nucleus bb install`;
 * - a failed install is reported with its cause and never fails or reverts the
 *   roll. The next landed roll runs the step again, so it retries.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginRollRecord } from "../../../shared/bb-plugin-roll";
import type { Command } from "./options";

/** `nucleus bb status` reads BB's own plugin list; it is bounded tightly. */
export const BB_STATUS_TIMEOUT_MS = 60_000;
/** `nucleus bb install` may build the plugin it installs, so it gets the route's own bound. */
export const BB_INSTALL_TIMEOUT_MS = 180_000;
/** Longest cause this step keeps from a command's output; the record is bounded too. */
const OUTPUT_KEEP = 2_000;

/** One command's answer, whatever became of its process. */
export interface BbCommandRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface BbPluginRollInput {
  /** The version root whose own CLI runs the step: the build this roll activated. */
  packageRoot: string;
  /** The Nucleus data home the service serves and the plugin connects to. */
  dataDir: string;
  /** The build the roll landed, recorded so health names what the step aimed at. */
  buildId: string;
  /** Test seam: run one command to completion. Production spawns it. */
  run?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<BbCommandRun>;
  /** Test seam: the clock. */
  now?: () => Date;
  /** The environment the CLI runs in; NUCLEUS_DATA_HOME is pinned to `dataDir`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The Nucleus CLI inside one version root, or null when that root ships no
 * compiled command (a source checkout, which has neither `runtime/node` nor a
 * packaged plugin to install). Nothing runs against an unbuilt root.
 */
export function bbPluginCli(root: string): Command | null {
  const node = join(root, "runtime", "node");
  const cli = join(root, "bin", "nucleus.mjs");
  return existsSync(node) && existsSync(cli)
    ? { command: node, args: [cli] }
    : null;
}

/** The status answer `nucleus bb status` prints, as far as this step reads it. */
function readStatus(
  run: BbCommandRun,
): { state: string; detail: string } | null {
  if (run.status !== 0) return null;
  let answer: unknown;
  try {
    answer = JSON.parse(run.stdout);
  } catch {
    return null;
  }
  const record = answer as { state?: unknown; detail?: unknown };
  if (typeof record?.state !== "string" || !record.state) return null;
  return {
    state: record.state,
    detail: typeof record.detail === "string" ? record.detail : "",
  };
}

/** How a command ended, for a cause a person reads. */
function ending(run: BbCommandRun): string {
  if (run.signal) return `stopped by ${run.signal}`;
  if (run.status === null) return "did not run";
  return `exit ${run.status}`;
}

/** The command's own words, bounded to the end where the cause is. */
function cause(run: BbCommandRun): string {
  const text = `${run.stderr}`.trim() || `${run.stdout}`.trim();
  return text.length > OUTPUT_KEEP ? `…${text.slice(-OUTPUT_KEEP)}` : text;
}

/**
 * Run the BB plugin step for one landed roll: report what BB has, install this
 * build's plugin only when BB reports it behind, and confirm the install landed.
 *
 * Null means "nothing to report": no compiled CLI at the version root, or a BB
 * that could not be run or could not answer. Those are machines this step leaves
 * exactly as it found them, and `nucleus bb status` remains the diagnostic. Every
 * other answer becomes a record the roll record and health both read.
 */
export async function bbPluginRoll(
  input: BbPluginRollInput,
): Promise<BbPluginRollRecord | null> {
  const cli = bbPluginCli(input.packageRoot);
  if (!cli) return null;
  const run = input.run ?? spawnCommand;
  const now = input.now ?? (() => new Date());
  const env = {
    ...(input.env ?? process.env),
    NUCLEUS_DATA_HOME: input.dataDir,
  };
  const record = (
    action: BbPluginRollRecord["action"],
    state: string,
    detail: string,
  ): BbPluginRollRecord => ({
    at: now().toISOString(),
    buildId: input.buildId,
    action,
    state,
    detail: detail.slice(-4000),
  });
  const call = async (
    args: string[],
    timeoutMs: number,
  ): Promise<BbCommandRun> => {
    try {
      return await run(cli.command, [...cli.args, ...args], { env, timeoutMs });
    } catch (error) {
      return {
        status: null,
        signal: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const before = readStatus(await call(["bb", "status"], BB_STATUS_TIMEOUT_MS));
  if (!before) return null;
  if (before.state !== "behind")
    return record("skipped", before.state, before.detail);
  const install = await call(["bb", "install"], BB_INSTALL_TIMEOUT_MS);
  if (install.status !== 0)
    return record(
      "failed",
      before.state,
      `nucleus bb install ${ending(install)}: ${cause(install) || "it wrote nothing"}`,
    );
  const after = readStatus(await call(["bb", "status"], BB_STATUS_TIMEOUT_MS));
  if (after?.state === "match")
    return record(
      "installed",
      after.state,
      after.detail || `installed the BB plugin from ${input.packageRoot}`,
    );
  return record(
    "failed",
    after?.state ?? before.state,
    after
      ? `nucleus bb install finished but the plugin still does not match this build: ${after.detail}`
      : "nucleus bb install finished but bb status could not be read again to confirm it",
  );
}

/** Run one command to completion, bounded, keeping the end of what it wrote. */
function spawnCommand(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<BbCommandRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const keep = (text: string, chunk: string) => {
      const next = text + chunk;
      return next.length > OUTPUT_KEEP ? next.slice(-OUTPUT_KEEP) : next;
    };
    const settle = (run: BbCommandRun) => {
      clearTimeout(timer);
      resolve(run);
    };
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* the child is already gone */
      }
    }, options.timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = keep(stdout, chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = keep(stderr, chunk);
    });
    child.once("error", (error) =>
      settle({
        status: null,
        signal: null,
        stdout,
        stderr: `${stderr}${error.message}`,
      }),
    );
    child.once("close", (status, signal) =>
      settle({ status, signal, stdout, stderr }),
    );
  });
}
