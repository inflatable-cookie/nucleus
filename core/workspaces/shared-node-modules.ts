import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { git } from "../git/git-command";

const execFileAsync = promisify(execFile);

type SharedInstallState = {
  schema: "nucleus.shared-node-modules.v1";
  status: "pending" | "failed" | "installed";
  fingerprint: string | null;
  updatedAt: string;
  error?: string;
};

const installLocks = new Map<string, Promise<void>>();

/**
 * Bring the registered checkout's shared npm install to the checked-out lockfile.
 * The state file lives beside Git metadata, outside node_modules: npm ci removes
 * node_modules before it installs, so a failed attempt must remain retryable.
 */
export async function ensureSharedNodeModules(repositoryPath: string, workspaceRoot?: string): Promise<void> {
  const commonDir = await git(repositoryPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const statePath = join(commonDir, "nucleus", "shared-node-modules.json");
  const previous = installLocks.get(statePath);
  let release!: () => void;
  const current = new Promise<void>(resolveLock => { release = resolveLock; });
  installLocks.set(statePath, current);
  await previous?.catch(() => undefined);
  try {
    await ensureLocked(repositoryPath, workspaceRoot, statePath);
  } finally {
    release();
    if (installLocks.get(statePath) === current) installLocks.delete(statePath);
  }
}

async function ensureLocked(repositoryPath: string, workspaceRoot: string | undefined, statePath: string): Promise<void> {
  const previous = await readState(statePath);
  const fingerprint = await lockFingerprint(repositoryPath);
  if (!fingerprint) {
    if (previous && previous.status !== "installed") {
      throw new Error(`Shared node_modules refresh remains ${previous.status}, but the npm lockfile is missing${previous.error ? `: ${previous.error}` : ""}`);
    }
    if (previous?.status === "installed" && previous.fingerprint !== null) {
      const detail = "The npm lockfile disappeared after a shared install was recorded";
      await writeState(statePath, { schema: "nucleus.shared-node-modules.v1", status: "failed", fingerprint: null, updatedAt: new Date().toISOString(), error: detail });
      throw new Error(`Shared node_modules refresh failed: ${detail}`);
    }
    return;
  }

  const modulesPath = join(repositoryPath, "node_modules");
  const routeExists = previous !== null || await hasRootLink(workspaceRoot, modulesPath);
  if (!routeExists) return;
  if (previous?.status === "installed" && previous.fingerprint === fingerprint && await pathExists(modulesPath)) return;

  await writeState(statePath, {
    schema: "nucleus.shared-node-modules.v1",
    status: "pending",
    fingerprint,
    updatedAt: new Date().toISOString(),
  });

  try {
    await execFileAsync("npm", ["ci"], {
      cwd: repositoryPath,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    if (!(await pathExists(modulesPath))) throw new Error("npm ci exited successfully without creating node_modules");
  } catch (error) {
    const detail = npmErrorDetail(error);
    const message = `Shared node_modules refresh failed with npm ci: ${detail}`;
    try {
      await writeState(statePath, {
        schema: "nucleus.shared-node-modules.v1",
        status: "failed",
        fingerprint,
        updatedAt: new Date().toISOString(),
        error: detail.slice(0, 8000),
      });
    } catch (stateError) {
      throw new Error(`${message}; recording the failed refresh also failed: ${npmErrorDetail(stateError)}`, { cause: error });
    }
    throw new Error(message, { cause: error });
  }

  await writeState(statePath, {
    schema: "nucleus.shared-node-modules.v1",
    status: "installed",
    fingerprint,
    updatedAt: new Date().toISOString(),
  });
}

async function lockFingerprint(repositoryPath: string): Promise<string | null> {
  const packageJson = await optionalRead(join(repositoryPath, "package.json"));
  const packageLock = await optionalRead(join(repositoryPath, "package-lock.json"));
  const shrinkwrap = await optionalRead(join(repositoryPath, "npm-shrinkwrap.json"));
  if (!packageLock && !shrinkwrap) return null;
  const hash = createHash("sha256");
  for (const [name, contents] of [["package.json", packageJson], ["package-lock.json", packageLock], ["npm-shrinkwrap.json", shrinkwrap]] as const) {
    hash.update(name);
    hash.update("\0");
    if (contents) hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function optionalRead(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** The root link is host-managed; this only proves that it targets this install. */
async function hasRootLink(workspaceRoot: string | undefined, modulesPath: string): Promise<boolean> {
  if (!workspaceRoot) return false;
  const linkPath = join(workspaceRoot, "node_modules");
  try {
    if (!(await lstat(linkPath)).isSymbolicLink()) return false;
    return resolve(workspaceRoot, await readlink(linkPath)) === resolve(modulesPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readState(path: string): Promise<SharedInstallState | null> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as SharedInstallState;
    if (state?.schema !== "nucleus.shared-node-modules.v1" || !["pending", "failed", "installed"].includes(state.status) ||
        !(typeof state.fingerprint === "string" || state.fingerprint === null) || typeof state.updatedAt !== "string")
      throw new Error("state fields do not match the supported schema");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Shared node_modules refresh state could not be read: ${npmErrorDetail(error)}`, { cause: error });
  }
}

async function writeState(path: string, state: SharedInstallState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

function npmErrorDetail(error: unknown): string {
  const result = error as NodeJS.ErrnoException & { stderr?: string | Buffer; stdout?: string | Buffer };
  const output = result.stderr?.toString().trim() || result.stdout?.toString().trim();
  return (output || result.message || String(error)).slice(0, 8000);
}
