import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { git } from "../git/git-command";

const execFileAsync = promisify(execFile);

type TaskInstallState = {
  schema: "nucleus.task-node-modules.v1";
  status: "pending" | "failed" | "installed";
  fingerprint: string;
  updatedAt: string;
  sourceHead?: string;
  sourceSignature?: string;
  failureKind?: "dirty_source";
  error?: string;
};

const installLocks = new Map<string, Promise<void>>();

/** Ensure a task that inherits the registered checkout's node_modules gets a
 * private install from its own lockfile before an agent starts. The marker is
 * per-worktree and outside node_modules so npm ci cannot erase a failed retry. */
export async function ensureTaskNodeModules(
  taskDirectory: string,
  registeredCheckout: string,
  workspaceRoot = dirname(taskDirectory),
  options?: {
    expectedCommonDir?: string | null;
    expectedCheckoutPath?: string | null;
  },
): Promise<void> {
  if (!(await lockFingerprint(taskDirectory))) return;
  if (options?.expectedCheckoutPath) {
    const [actualDir, expectedDir] = await Promise.all([
      realpath(taskDirectory),
      realpath(options.expectedCheckoutPath),
    ]);
    if (actualDir !== expectedDir)
      throw new Error("Task worktree path does not match recorded allocation");
  }
  const taskRoot = await git(taskDirectory, "rev-parse", "--show-toplevel");
  if ((await realpath(taskRoot).catch(() => resolve(taskRoot))) !== (await realpath(taskDirectory).catch(() => resolve(taskDirectory))))
    throw new Error("Task dependency setup requires the task worktree root");
  const taskCommon = await git(
    taskDirectory,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  if (options?.expectedCommonDir) {
    const [actualCommon, expectedCommon] = await Promise.all([
      realpath(taskCommon).catch(() => resolve(taskCommon)),
      realpath(options.expectedCommonDir).catch(() => resolve(options.expectedCommonDir!)),
    ]);
    if (actualCommon !== expectedCommon)
      throw new Error("Task worktree does not belong to the recorded Barge allocation");
  } else {
    const registeredCommon = await git(
      registeredCheckout,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    if (resolve(taskCommon) !== resolve(registeredCommon))
      throw new Error("Task worktree does not belong to the registered checkout");
  }
  if (resolve(taskDirectory) === resolve(registeredCheckout))
    throw new Error(
      "Refusing task dependency setup in the registered checkout",
    );

  const gitDir = await git(
    taskDirectory,
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  );
  const statePath = join(gitDir, "nucleus", "task-node-modules.json");
  const previous = installLocks.get(statePath);
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  installLocks.set(statePath, current);
  await previous?.catch(() => undefined);
  try {
    await ensureLocked(
      taskDirectory,
      registeredCheckout,
      workspaceRoot,
      statePath,
    );
  } finally {
    release();
    if (installLocks.get(statePath) === current) installLocks.delete(statePath);
  }
}

async function ensureLocked(
  taskDirectory: string,
  registeredCheckout: string,
  workspaceRoot: string,
  statePath: string,
): Promise<void> {
  const fingerprint = await lockFingerprint(taskDirectory);
  if (!fingerprint) return;
  const previous = await readState(statePath);
  const localModules = join(taskDirectory, "node_modules");
  const sharedModules = join(registeredCheckout, "node_modules");
  const checkoutName = basename(taskDirectory);
  const isolatedParent =
    checkoutName.startsWith("ns-") &&
    basename(workspaceRoot) === `task-${checkoutName.slice(3)}`;
  const sharedRoute =
    previous !== null ||
    (await hasRootLink(workspaceRoot, sharedModules)) ||
    (isolatedParent &&
      (await hasRootLink(dirname(workspaceRoot), sharedModules))) ||
    (await isSymlink(localModules));
  if (!sharedRoute) return;
  if (
    previous?.status === "installed" &&
    previous.fingerprint === fingerprint &&
    (await hasPrivateInstall(localModules))
  )
    return;

  let sourceBefore: TrackedSourceState;
  try {
    sourceBefore = await trackedSourceState(taskDirectory);
  } catch (error) {
    const detail = `Tracked source could not be verified before npm ci: ${npmErrorDetail(error)}`;
    await writeState(statePath, {
      schema: "nucleus.task-node-modules.v1",
      status: "failed",
      fingerprint,
      updatedAt: new Date().toISOString(),
      error: detail.slice(0, 8000),
    });
    throw new Error(`Task node_modules setup failed with npm ci: ${detail}`, {
      cause: error,
    });
  }

  // A previous npm ci may have changed tracked source before it failed or the
  // process stopped. Don't reinterpret that mutation as intentional task work
  // on a retry at the same commit; require a source restore or new commit.
  if (
    previous &&
    (previous.status === "pending" || previous.status === "failed") &&
    previous.failureKind !== "dirty_source" &&
    previous.fingerprint === fingerprint &&
    previous.sourceHead === sourceBefore.head &&
    previous.sourceSignature &&
    previous.sourceSignature !== sourceBefore.signature
  ) {
    const detail =
      "Tracked source changed during a previous npm ci attempt; restore it or advance the task head before retrying";
    await writeState(statePath, {
      ...previous,
      status: "failed",
      updatedAt: new Date().toISOString(),
      error: detail,
    });
    throw new Error(`Task node_modules setup failed with npm ci: ${detail}`);
  }

  // npm lifecycle scripts can overwrite already-dirty tracked files before a
  // post-install comparison gets a chance to refuse. Keep retained worker work
  // intact by refusing setup whenever the index or worktree is already dirty.
  if (sourceBefore.dirty) {
    const detail =
      "Tracked task source is dirty before npm ci; refusing setup to preserve retained work";
    await writeState(statePath, {
      schema: "nucleus.task-node-modules.v1",
      status: "failed",
      failureKind: "dirty_source",
      fingerprint,
      updatedAt: new Date().toISOString(),
      sourceHead: sourceBefore.head,
      sourceSignature: sourceBefore.signature,
      error: detail,
    });
    throw new Error(`Task node_modules setup refused before npm ci: ${detail}`);
  }

  await writeState(statePath, {
    schema: "nucleus.task-node-modules.v1",
    status: "pending",
    fingerprint,
    updatedAt: new Date().toISOString(),
    sourceHead: sourceBefore.head,
    sourceSignature: sourceBefore.signature,
  });

  try {
    await detachSharedLink(localModules, sharedModules, taskDirectory);
    await execFileAsync("npm", ["ci"], {
      cwd: taskDirectory,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    if (!(await hasPrivateInstall(localModules)))
      throw new Error(
        "npm ci exited successfully without creating a private task node_modules directory",
      );
    const sourceAfter = await trackedSourceState(taskDirectory);
    if (
      sourceAfter.head !== sourceBefore.head ||
      sourceAfter.signature !== sourceBefore.signature
    )
      throw new Error(
        "npm ci changed tracked task source; refusing to start an agent",
      );
  } catch (error) {
    const detail = npmErrorDetail(error);
    const message = `Task node_modules setup failed with npm ci: ${detail}`;
    try {
      await writeState(statePath, {
        schema: "nucleus.task-node-modules.v1",
        status: "failed",
        fingerprint,
        updatedAt: new Date().toISOString(),
        sourceHead: sourceBefore.head,
        sourceSignature: sourceBefore.signature,
        error: detail.slice(0, 8000),
      });
    } catch (stateError) {
      throw new Error(
        `${message}; recording the failed setup also failed: ${npmErrorDetail(stateError)}`,
        { cause: error },
      );
    }
    throw new Error(message, { cause: error });
  }

  await writeState(statePath, {
    schema: "nucleus.task-node-modules.v1",
    status: "installed",
    fingerprint,
    updatedAt: new Date().toISOString(),
    sourceHead: sourceBefore.head,
    sourceSignature: sourceBefore.signature,
  });
}

type TrackedSourceState = { head: string; signature: string; dirty: boolean };

async function trackedSourceState(
  taskDirectory: string,
): Promise<TrackedSourceState> {
  const [head, staged, unstaged] = await Promise.all([
    git(taskDirectory, "rev-parse", "HEAD"),
    git(
      taskDirectory,
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-renames",
      "HEAD",
    ),
    git(
      taskDirectory,
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-renames",
    ),
  ]);
  return {
    head,
    signature: createHash("sha256")
      .update(head)
      .update("\0")
      .update(staged)
      .update("\0")
      .update(unstaged)
      .digest("hex"),
    dirty: Boolean(staged || unstaged),
  };
}

async function lockFingerprint(taskDirectory: string): Promise<string | null> {
  // Most repositories have no npm lockfile. Avoid yielding through several
  // asynchronous reads on their launch path when there is no npm install to do.
  if (!hasNpmLockfile(taskDirectory)) return null;
  const packageJson = await optionalRead(join(taskDirectory, "package.json"));
  const packageLock = await optionalRead(
    join(taskDirectory, "package-lock.json"),
  );
  const shrinkwrap = await optionalRead(
    join(taskDirectory, "npm-shrinkwrap.json"),
  );
  if (!packageLock && !shrinkwrap) return null;
  const hash = createHash("sha256");
  for (const [name, contents] of [
    ["package.json", packageJson],
    ["package-lock.json", packageLock],
    ["npm-shrinkwrap.json", shrinkwrap],
  ] as const) {
    hash.update(name);
    hash.update("\0");
    if (contents) hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function hasNpmLockfile(taskDirectory: string): boolean {
  for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
    try {
      lstatSync(join(taskDirectory, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

async function optionalRead(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function hasPrivateInstall(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function detachSharedLink(
  localModules: string,
  sharedModules: string,
  taskDirectory: string,
): Promise<void> {
  try {
    if (!(await lstat(localModules)).isSymbolicLink()) return;
    const target = resolve(taskDirectory, await readlink(localModules));
    if (target !== resolve(sharedModules))
      throw new Error(
        `Task node_modules is a symlink to an unexpected location: ${target}`,
      );
    await unlink(localModules);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function hasRootLink(
  workspaceRoot: string,
  modulesPath: string,
): Promise<boolean> {
  const linkPath = join(workspaceRoot, "node_modules");
  try {
    if (!(await lstat(linkPath)).isSymbolicLink()) return false;
    return (
      resolve(workspaceRoot, await readlink(linkPath)) === resolve(modulesPath)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readState(path: string): Promise<TaskInstallState | null> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as TaskInstallState;
    if (
      state?.schema !== "nucleus.task-node-modules.v1" ||
      !["pending", "failed", "installed"].includes(state.status) ||
      typeof state.fingerprint !== "string" ||
      typeof state.updatedAt !== "string"
    )
      throw new Error("state fields do not match the supported schema");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `Task node_modules setup state could not be read: ${npmErrorDetail(error)}`,
      { cause: error },
    );
  }
}

async function writeState(
  path: string,
  state: TaskInstallState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

function npmErrorDetail(error: unknown): string {
  const result = error as NodeJS.ErrnoException & {
    stderr?: string | Buffer;
    stdout?: string | Buffer;
  };
  const output =
    result.stderr?.toString().trim() || result.stdout?.toString().trim();
  return (output || result.message || String(error)).slice(0, 8000);
}
