import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BargeCustodian,
  type WorkspaceAllocation,
} from "../../shared/schema/workspace";
import { processCommandLineAsync } from "../machine/process-identity";
import {
  readHostRunStartIdentity,
  startIdentityMatches,
} from "../machine/start-identity";
import {
  BargeCliError,
  bargeWorktreeStatus,
  buildBargeEnv,
  resolveBargeBinary,
  type BargeClientOptions,
} from "./barge-cli";
import { getWorkPlacement } from "./work-root.mjs";
import { assertWorkPlacementAvailable } from "./checkout-volume";

const CUSTODIAN_SCRIPT_PATH = fileURLToPath(
  new URL("./barge-custodian.mjs", import.meta.url),
);

const CUSTODIAN_READY_TIMEOUT_MS = 10_000;
const CUSTODIAN_STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 40;

export class BargeCustodyLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BargeCustodyLostError";
  }
}

export class BargeUnsupportedCustodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BargeUnsupportedCustodyError";
  }
}

export interface BargeCustodianStartInput {
  allocationId: string;
  leaseId: string;
  repoPath: string;
  controlRootDir?: string;
  cliOptions?: BargeClientOptions;
}

export interface BargeCustodianVerification {
  status: "holding" | "lost" | "unavailable";
  reason?: string;
  checkedAt: string;
  custodian: BargeCustodian;
}

export interface BargeCustodianDriver {
  start(input: BargeCustodianStartInput): Promise<BargeCustodian>;
  verify(
    allocation: WorkspaceAllocation,
    cliOptions?: BargeClientOptions,
  ): Promise<BargeCustodianVerification>;
  release(
    allocation: WorkspaceAllocation,
    cliOptions?: BargeClientOptions,
  ): Promise<BargeCustodian>;
}

let custodianDriverOverride: BargeCustodianDriver | null = null;

/** Test hook to inject a deterministic custodian driver without patching OS processes. */
export function overrideBargeCustodianDriverForTest(
  driver: BargeCustodianDriver | null,
): void {
  custodianDriverOverride = driver;
}

function custodianControlRoot(controlRootDir?: string): string {
  if (controlRootDir) return controlRootDir;
  const placement = getWorkPlacement();
  // Custodian control files are one lease's live start/stop handshake: the
  // scratch class, on the configured work volume.
  assertWorkPlacementAvailable(placement);
  return placement.custodianRoot;
}

function defaultCustodianControlDir(
  allocationId: string,
  token: string,
  controlRootDir?: string,
): string {
  const safeId = allocationId.replace(/[^A-Za-z0-9-_.]/g, "_").slice(0, 64);
  return join(
    custodianControlRoot(controlRootDir),
    `${safeId}-${token.slice(0, 8)}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBargeRunFailure(
  code: number | null,
  stderr: string,
): BargeCliError {
  const trimmed = stderr.trim();
  if (trimmed) {
    for (const candidate of [trimmed, trimmed.split(/\r?\n/).pop() ?? ""]) {
      if (!candidate.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(candidate) as {
          schema?: string;
          error?: { kind?: string; message?: string };
        };
        if (parsed?.schema === "barge.error/1" && parsed.error?.message) {
          const kind =
            parsed.error.kind === "usage" ||
            parsed.error.kind === "refused" ||
            parsed.error.kind === "not_found" ||
            parsed.error.kind === "unknown_state" ||
            parsed.error.kind === "io" ||
            parsed.error.kind === "unsupported"
              ? parsed.error.kind
              : "io";
          return new BargeCliError(kind, parsed.error.message, {
            exitCode: code,
            stderr,
          });
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  }
  if (/unknown.*command.*run/i.test(trimmed)) {
    return new BargeCliError("unsupported", trimmed, {
      exitCode: code,
      stderr,
    });
  }
  return new BargeCliError(
    "io",
    trimmed || `barge worktree run exited early with code ${code ?? "null"}`,
    { exitCode: code, stderr },
  );
}

async function defaultStartCustodian(
  input: BargeCustodianStartInput,
): Promise<BargeCustodian> {
  const token = randomUUID();
  const controlDir = defaultCustodianControlDir(
    input.allocationId,
    token,
    input.controlRootDir,
  );
  await mkdir(controlDir, { recursive: true });
  const readyFile = join(controlDir, "ready.json");
  const stopFile = join(controlDir, "stop");
  const startedAt = new Date().toISOString();

  const bin = resolveBargeBinary(input.cliOptions?.bin);
  const env = buildBargeEnv(input.cliOptions?.env);
  const argv = [
    "--json",
    "worktree",
    "run",
    "--lease",
    input.leaseId,
    "--",
    process.execPath,
    CUSTODIAN_SCRIPT_PATH,
    "--lease",
    input.leaseId,
    "--token",
    token,
    "--ready",
    readyFile,
    "--stop",
    stopFile,
  ];

  let stderrChunks = "";
  let child: ChildProcess;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  let spawnErr: Error | null = null;

  child = spawn(bin, argv, {
    env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderrChunks.length < 16_384) stderrChunks += chunk;
  });
  child.once("error", (err) => {
    spawnErr = err;
  });
  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
  });

  try {
    const deadline = Date.now() + CUSTODIAN_READY_TIMEOUT_MS;
    let readyPayload: {
      pid?: number;
      leaseId?: string;
      token?: string;
    } | null = null;

    while (Date.now() < deadline) {
      if (spawnErr) {
        const errno = (spawnErr as NodeJS.ErrnoException).code;
        if (errno === "ENOENT") {
          throw new BargeCliError(
            "io",
            `Barge CLI binary \`${bin}\` is unavailable (${errno})`,
          );
        }
        throw spawnErr;
      }
      const exited = exitInfo as {
        code: number | null;
        signal: NodeJS.Signals | null;
      } | null;
      if (exited) {
        const failure = parseBargeRunFailure(exited.code, stderrChunks);
        if (failure.isUnsupportedRunCommand()) {
          throw new BargeUnsupportedCustodyError(
            `Barge CLI does not support \`worktree run\` lease custody yet: ${failure.message}`,
          );
        }
        throw failure;
      }
      const raw = await readFile(readyFile, "utf8").catch(() => null);
      if (raw) {
        try {
          readyPayload = JSON.parse(raw) as {
            pid?: number;
            leaseId?: string;
            token?: string;
          };
          break;
        } catch {
          /* wait for rename if partial */
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }

    if (
      !readyPayload ||
      typeof readyPayload.pid !== "number" ||
      readyPayload.token !== token ||
      readyPayload.leaseId !== input.leaseId
    ) {
      try {
        await writeFile(stopFile, "abort\n");
      } catch {
        /* best effort */
      }
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          /* ignore */
        }
      }
      throw new BargeCliError(
        "io",
        `Timed out waiting for Barge lease custodian readiness on lease ${input.leaseId}`,
      );
    }

    const pid = readyPayload.pid;
    const identityRead = await readHostRunStartIdentity(pid);
    if (identityRead.kind !== "identity") {
      try {
        await writeFile(stopFile, "abort\n");
      } catch {
        /* ignore */
      }
      throw new BargeCustodyLostError(
        `Barge lease custodian pid ${pid} disappeared before identity proof on lease ${input.leaseId}`,
      );
    }

    // Confirm through `barge worktree status` that the lease root is actually held.
    const pools = await bargeWorktreeStatus(
      { repo: input.repoPath },
      input.cliOptions,
    );
    const matchingRoot = pools
      .flatMap((pool) => pool.roots)
      .find((root) => root.lease_id === input.leaseId);
    if (matchingRoot && !matchingRoot.held) {
      try {
        await writeFile(stopFile, "abort\n");
      } catch {
        /* ignore */
      }
      throw new BargeCustodyLostError(
        `Barge reported \`held: false\` immediately after launching custodian for lease ${input.leaseId}`,
      );
    }

    // Detach stdio pipes so Nucleus service rolls leave the custodian running cleanly.
    child.stderr?.destroy();
    child.unref();

    return {
      state: "holding",
      token,
      pid,
      startIdentity: identityRead.identity,
      readyFile,
      stopFile,
      startedAt,
      verifiedAt: new Date().toISOString(),
      releasedAt: null,
      error: null,
    };
  } catch (error) {
    child.stderr?.destroy();
    try {
      await rm(controlDir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
    throw error;
  }
}

async function defaultVerifyCustodian(
  allocation: WorkspaceAllocation,
  cliOptions?: BargeClientOptions,
): Promise<BargeCustodianVerification> {
  const checkedAt = new Date().toISOString();
  const custodian = allocation.custodian;
  if (!custodian) {
    return {
      status: "lost",
      reason: `Barge allocation ${allocation.allocationId} has no recorded custodian`,
      checkedAt,
      custodian: {
        state: "lost",
        token: "missing",
        pid: null,
        startIdentity: null,
        readyFile: null,
        stopFile: null,
        startedAt: checkedAt,
        verifiedAt: null,
        releasedAt: null,
        error: "Custodian record is missing",
      },
    };
  }
  if (custodian.state === "lost") {
    return {
      status: "lost",
      reason: custodian.error ?? "Custodian was previously marked lost",
      checkedAt,
      custodian,
    };
  }
  if (custodian.state === "released") {
    return {
      status: "lost",
      reason: "Custodian was already released while lease remained active",
      checkedAt,
      custodian: {
        ...custodian,
        state: "lost",
        error: "Custodian released unexpectedly",
      },
    };
  }
  if (!custodian.pid || !custodian.startIdentity) {
    return {
      status: "lost",
      reason: "Custodian lacks recorded process identity",
      checkedAt,
      custodian: {
        ...custodian,
        state: "lost",
        error: "Custodian lacks recorded process identity",
      },
    };
  }

  let processCheckUnavailable: string | null = null;
  const idRead = await readHostRunStartIdentity(custodian.pid);
  if (idRead.kind === "unavailable") {
    processCheckUnavailable = `Process identity for custodian pid ${custodian.pid} could not be observed`;
  } else if (
    idRead.kind === "gone" ||
    !startIdentityMatches(custodian.startIdentity, idRead.identity)
  ) {
    const reason =
      idRead.kind === "gone"
        ? `Custodian process pid ${custodian.pid} is no longer running for lease ${allocation.leaseId}`
        : `Custodian process pid ${custodian.pid} start identity changed (process recycled)`;
    return {
      status: "lost",
      reason,
      checkedAt,
      custodian: { ...custodian, state: "lost", error: reason },
    };
  } else {
    const cmdline = await processCommandLineAsync(custodian.pid);
    if (cmdline !== null && !cmdline.includes(custodian.token)) {
      const reason = `Custodian process pid ${custodian.pid} does not carry recorded custody token ${custodian.token}`;
      return {
        status: "lost",
        reason,
        checkedAt,
        custodian: { ...custodian, state: "lost", error: reason },
      };
    }
  }

  if (allocation.leaseId) {
    try {
      const pools = await bargeWorktreeStatus(
        { repo: allocation.repoIdentifier ?? allocation.repoPath },
        cliOptions,
      );
      const matchingPool = pools.find(
        (pool) =>
          pool.pool === allocation.pool ||
          pool.roots.some((r) => r.lease_id === allocation.leaseId),
      );
      if (matchingPool?.unavailable) {
        return {
          status: "unavailable",
          reason: matchingPool.unavailable,
          checkedAt,
          custodian,
        };
      }
      const root = pools
        .flatMap((pool) => pool.roots)
        .find((r) => r.lease_id === allocation.leaseId);
      if (root && !root.held) {
        const reason = `Barge status reports root ${root.id} is no longer held for active lease ${allocation.leaseId}`;
        return {
          status: "lost",
          reason,
          checkedAt,
          custodian: { ...custodian, state: "lost", error: reason },
        };
      }
    } catch (error) {
      return {
        status: "unavailable",
        reason: `Barge status unavailable during custody verification: ${error instanceof Error ? error.message : String(error)}`,
        checkedAt,
        custodian,
      };
    }
  }

  if (processCheckUnavailable) {
    return {
      status: "unavailable",
      reason: processCheckUnavailable,
      checkedAt,
      custodian,
    };
  }

  return {
    status: "holding",
    checkedAt,
    custodian: {
      ...custodian,
      state: "holding",
      verifiedAt: checkedAt,
      error: null,
    },
  };
}

async function defaultReleaseCustodian(
  allocation: WorkspaceAllocation,
  cliOptions?: BargeClientOptions,
): Promise<BargeCustodian> {
  const custodian = allocation.custodian;
  if (!custodian) {
    throw new BargeCustodyLostError(
      `Cannot release custodian for Barge lease ${allocation.leaseId ?? allocation.allocationId}: no custodian record`,
    );
  }
  if (custodian.state === "released") return custodian;
  if (custodian.state === "lost") {
    throw new BargeCustodyLostError(
      custodian.error ??
        `Custody lost for Barge lease ${allocation.leaseId ?? allocation.allocationId}; return remains fenced`,
    );
  }

  // Verify the custodian did not die silently BEFORE intentional release.
  const verification = await defaultVerifyCustodian(allocation, cliOptions);
  if (verification.status === "lost") {
    throw new BargeCustodyLostError(
      verification.reason ??
        `Custodian disappeared before intentional release on lease ${allocation.leaseId}`,
    );
  }

  if (custodian.stopFile) {
    await mkdir(join(custodian.stopFile, ".."), { recursive: true }).catch(
      () => undefined,
    );
    await writeFile(custodian.stopFile, `${new Date().toISOString()}\n`).catch(
      () => undefined,
    );
  }

  if (custodian.pid && custodian.startIdentity) {
    const idRead = await readHostRunStartIdentity(custodian.pid);
    if (
      idRead.kind === "identity" &&
      startIdentityMatches(custodian.startIdentity, idRead.identity)
    ) {
      const cmdline = await processCommandLineAsync(custodian.pid);
      if (cmdline === null || cmdline.includes(custodian.token)) {
        try {
          process.kill(custodian.pid, "SIGTERM");
        } catch {
          /* already exited */
        }
      }
    }

    const deadline = Date.now() + CUSTODIAN_STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const poll = await readHostRunStartIdentity(custodian.pid);
      if (
        poll.kind === "gone" ||
        (poll.kind === "identity" &&
          !startIdentityMatches(custodian.startIdentity, poll.identity))
      ) {
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  if (custodian.stopFile) {
    await rm(join(custodian.stopFile, ".."), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }

  const releasedAt = new Date().toISOString();
  return {
    ...custodian,
    state: "released",
    releasedAt,
    error: null,
  };
}

const defaultDriver: BargeCustodianDriver = {
  start: defaultStartCustodian,
  verify: defaultVerifyCustodian,
  release: defaultReleaseCustodian,
};

function activeDriver(): BargeCustodianDriver {
  return custodianDriverOverride ?? defaultDriver;
}

export function startBargeCustodian(
  input: BargeCustodianStartInput,
): Promise<BargeCustodian> {
  return activeDriver().start(input);
}

export function verifyBargeCustodian(
  allocation: WorkspaceAllocation,
  cliOptions?: BargeClientOptions,
): Promise<BargeCustodianVerification> {
  return activeDriver().verify(allocation, cliOptions);
}

export function releaseBargeCustodian(
  allocation: WorkspaceAllocation,
  cliOptions?: BargeClientOptions,
): Promise<BargeCustodian> {
  return activeDriver().release(allocation, cliOptions);
}
