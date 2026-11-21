/**
 * Shared helpers for the private T3Code nightly proofs (nucleus#1366, nucleus#1378).
 *
 * A proof runs against the installed nightly's own server entry, extracted from its
 * app archive into the run's scratch. Every process, port and temporary root is owned
 * by the run. Nothing here reads a live T3 home, session or desktop data directory.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Engine } from "../../core/engine";
import type { Adapter } from "../../core/host";
import { enginePorts } from "../../core/port-context";
import { HostPass } from "../../core/scheduling/host-pass";
import type { Store } from "../../core/store/store";

/** The nightly line the proofs read; the exact installed build is recorded, never pinned. */
export const NIGHTLY_LINE = /^0\.1\.11-nightly\.\d+\.\d+$/;

/** The run's scratch root, which the run must already own (never created here). */
export function scratchRoot(): string {
  const root = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  if (!root || !existsSync(root) || !statSync(root).isDirectory())
    throw new Error("The run scratch volume is required");
  return realpathSync(root);
}

type ArchiveEntry = {
  files?: Record<string, ArchiveEntry>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  link?: string;
};

/** Extract the nightly's server bundle and root manifest from its app archive. */
export function extractArchive(source: string, destination: string): void {
  const fd = openSync(source, "r");
  try {
    const prelude = Buffer.alloc(16);
    assert.equal(readSync(fd, prelude, 0, 16, 0), 16);
    const headerSize = prelude.readUInt32LE(12);
    assert.ok(
      headerSize > 0 && headerSize < 16 * 1024 * 1024,
      "bounded header",
    );
    const header = Buffer.alloc(headerSize);
    readSync(fd, header, 0, headerSize, 16);
    const tree = JSON.parse(header.toString()) as ArchiveEntry;
    const base = prelude.readUInt32LE(4) + 8;
    const walk = (entry: ArchiveEntry, relative: string) => {
      const target = resolve(destination, relative);
      assert.ok(
        target === destination || target.startsWith(destination + sep),
        "archive entry stays inside the fixture",
      );
      if (entry.files) {
        mkdirSync(target, { recursive: true });
        for (const [name, child] of Object.entries(entry.files))
          walk(child, join(relative, name));
      } else if (entry.link) {
        const linkTarget = resolve(destination, entry.link);
        assert.ok(
          linkTarget.startsWith(destination + sep),
          "link stays inside the fixture",
        );
        symlinkSync(linkTarget, target);
      } else if (entry.unpacked) {
        mkdirSync(resolve(target, ".."), { recursive: true });
        copyFileSync(join(source + ".unpacked", relative), target);
      } else {
        assert.ok(
          typeof entry.size === "number" &&
            entry.size >= 0 &&
            entry.size < 64 * 1024 * 1024,
          "bounded archive entry",
        );
        const bytes = Buffer.alloc(entry.size);
        readSync(fd, bytes, 0, bytes.length, base + Number(entry.offset));
        mkdirSync(resolve(target, ".."), { recursive: true });
        writeFileSync(target, bytes);
      }
    };
    const manifest = tree.files?.["package.json"];
    assert.ok(manifest, "the archive carries its manifest");
    walk(manifest, "package.json");
    const modules = tree.files?.node_modules;
    assert.ok(modules, "the archive carries its dependencies");
    walk(modules, "node_modules");
    const serverBundle = tree.files?.apps?.files?.server;
    assert.ok(serverBundle, "the archive carries apps/server");
    walk(serverBundle, "apps/server");
  } finally {
    closeSync(fd);
  }
}

export async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((ready) => socket.listen(0, "127.0.0.1", ready));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((closed) => socket.close(() => closed()));
  return port;
}

/** Poll until `read` returns a truthy value; a non-snapshot error is raised at once. */
export async function until<T>(
  read: () => Promise<T>,
  what: string,
  milliseconds = 60_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + milliseconds;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (!/changed during snapshot|snapshotSequence changed/.test(last))
        throw error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

/** Run one setup command; a credential's output is withheld from any error. */
export async function run(
  argv: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; secret?: boolean },
): Promise<string> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (bytes) => (stdout += bytes));
    child.stderr!.on("data", (bytes) => (stderr += bytes));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolveRun(stdout);
      const detail = stderr
        .split("\n")
        .filter((line) => line.trim() && !/^\s+at /.test(line))
        .slice(-6)
        .join(" | ");
      reject(
        new Error(
          `${options.secret ? "credential" : "setup"} command exited ${code}: ${options.secret ? "output withheld" : detail}`,
        ),
      );
    });
  });
}

/**
 * One ordinary host maintenance pass over a real store and a real host adapter: the
 * same owner, step set and order the service sweep runs for a host (`HostPass.run`),
 * including the finished-parent archive step that reads the host's own durable parent
 * bindings. A proof uses it instead of calling a presentation or archive method
 * directly, so what it observes is the path production takes.
 */
export async function runOrdinaryHostPass(
  store: Store,
  adapter: Adapter,
  hostId: string,
): Promise<void> {
  const engine = new Engine(store, adapter, 60_000);
  try {
    const pass = new HostPass(
      enginePorts(
        engine,
        [
          "adapter",
          "host",
          "inventoryHostMatches",
          "observeRetiredWorkers",
          "retiredObservationKey",
          "retiredObservationPlan",
          "scheduleLane",
          "stopped",
          "store",
        ],
        ["observationTargets"],
      ),
    );
    await engine.withHost(hostId, () => pass.run(hostId));
  } finally {
    await engine.stop();
  }
}
