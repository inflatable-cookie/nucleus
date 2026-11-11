import type { BuildOutputCleanupResult, BuildOutputCleanupHooks } from '../host/types';
export type { BuildOutputCleanupResult, BuildOutputCleanupHooks } from '../host/types';
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Store } from "../store/store";
import { git as defaultGit } from "../git/index";
import { cleanupReasonFor, coverRunBuildOutput } from "../hooks/build-output-records";

const execFileAsync = promisify(execFile);

// `.northstar-cache` is the retired cache folder name; recorded checkouts may still hold one.
const skippedDirectoryNames = new Set([".git", ".northstar-cache", "target"]);
/**
 * Audit B8: a cleanup detail names at most this many entries plus the remaining count, so
 * one giant Cargo tree cannot put hundreds of paths into every event and task row. The
 * first entries keep their full reason: the first failure is the actionable evidence.
 */
const DETAIL_LIST_LIMIT = 5;
function boundedList(items: string[], separator = ", "): string {
  if (items.length <= DETAIL_LIST_LIMIT) return items.join(separator);
  return `${items.slice(0, DETAIL_LIST_LIMIT).join(separator)}${separator}and ${items.length - DETAIL_LIST_LIMIT} more`;
}

const isWithin = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

type BuildRootKind = "Cargo target" | "node_modules";
interface BuildRoot { path: string; kinds: Set<BuildRootKind>; sources: Set<string> }
interface SkippedRoot { path: string; reason: string }
interface CargoMetadata {
  workspace_root?: unknown;
  target_directory?: unknown;
}

function addRoot(roots: Map<string, BuildRoot>, path: string, kind: BuildRootKind, source?: string) {
  const absolute = resolve(path);
  const root = roots.get(absolute) ?? { path: absolute, kinds: new Set<BuildRootKind>(), sources: new Set<string>() };
  root.kinds.add(kind);
  if (source) root.sources.add(source);
  roots.set(absolute, root);
}

function rootProvenance(root: BuildRoot) {
  return root.sources.size ? `; ${[...root.sources].join("; ")}` : "";
}

async function cargoConfigContext(directory: string) {
  const paths: string[] = [];
  let current = directory;
  while (true) {
    for (const name of ["config.toml", "config"]) {
      const path = join(current, ".cargo", name);
      try {
        const stat = await lstat(path);
        if (stat.isFile() || stat.isSymbolicLink()) paths.push(path);
      } catch { /* Missing config candidates do not affect Cargo. */ }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const cargoHome = resolve(process.env.CARGO_HOME || join(homedir(), ".cargo"));
  for (const name of ["config.toml", "config"]) {
    const path = join(cargoHome, name);
    try {
      const stat = await lstat(path);
      if (stat.isFile() || stat.isSymbolicLink()) paths.push(path);
    } catch { /* Missing global config candidates do not affect Cargo. */ }
  }
  return [...new Set(paths)];
}

function cargoErrorText(error: unknown) {
  const detail = error as { stderr?: unknown; message?: unknown };
  const stderr = typeof detail.stderr === "string" ? detail.stderr.trim() : "";
  const message = typeof detail.message === "string" ? detail.message : String(error);
  return (stderr || message).replace(/\s+/g, " ").slice(0, 1200);
}

async function discoverBuildRoots(checkout: string): Promise<{ roots: Map<string, BuildRoot>; skipped: SkippedRoot[]; notes: SkippedRoot[] }> {
  const roots = new Map<string, BuildRoot>();
  const skipped: SkippedRoot[] = [];
  // Informational only: a manifest Cargo cannot resolve in place (e.g. a staged proof crate that
  // is deliberately not a workspace member) still had its conventional target/ added above.
  const notes: SkippedRoot[] = [];
  const cargoPackages: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      skipped.push({ path: directory, reason: `Could not inspect worktree contents: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (skippedDirectoryNames.has(entry.name)) continue;
      if (entry.name === "node_modules") {
        addRoot(roots, path, "node_modules");
        continue;
      }
      if (entry.name === "Cargo.toml" && (entry.isFile() || entry.isSymbolicLink())) {
        cargoPackages.push(directory);
        continue;
      }
      if (entry.isDirectory()) await visit(path);
    }
  };

  await visit(checkout);
  for (const packageDirectory of cargoPackages.sort((left, right) => left.length - right.length)) {
    const configPaths = await cargoConfigContext(packageDirectory);
    const configDescription = configPaths.length ? configPaths.join(", ") : "none found";
    const environmentOverrides = ["CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR"].filter(name => process.env[name]);
    const configContext = `Cargo config path(s): ${configDescription}${environmentOverrides.length ? `; environment override: ${environmentOverrides.join(", ")}` : ""}`;
    addRoot(roots, join(packageDirectory, "target"), "Cargo target", `Cargo package root ${packageDirectory}; ${configContext}`);
    let metadata: CargoMetadata;
    try {
      const { stdout } = await execFileAsync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--locked"], {
        cwd: packageDirectory, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      });
      metadata = JSON.parse(stdout) as CargoMetadata;
    } catch (error) {
      // Longhorn, 2026-09-30: ~20 staged proof crates are not root-workspace members, so
      // `cargo metadata` fails in place. Blocking on that held every Longhorn archive though
      // no output existed; the conventional target/ is still cleaned above.
      notes.push({ path: packageDirectory, reason: `Cargo metadata failed from package/workspace root ${packageDirectory}, so only its conventional target/ was considered; ${configContext}; ${cargoErrorText(error)}` });
      continue;
    }

    if (typeof metadata.workspace_root !== "string" || typeof metadata.target_directory !== "string" || !isAbsolute(metadata.workspace_root) || !isAbsolute(metadata.target_directory)) {
      const workspaceRoot = typeof metadata.workspace_root === "string" ? metadata.workspace_root : "unavailable";
      skipped.push({ path: packageDirectory, reason: `Cargo metadata from package root ${packageDirectory} returned incomplete or relative paths (workspace root: ${workspaceRoot}); ${configContext}` });
      continue;
    }
    const workspaceRoot = resolve(metadata.workspace_root);
    const targetDirectory = resolve(metadata.target_directory);
    const source = `Cargo package root ${packageDirectory}; workspace root ${workspaceRoot}; ${configContext}`;
    if (!isWithin(checkout, workspaceRoot)) {
      skipped.push({ path: targetDirectory, reason: `${source}; workspace root is outside the task worktree` });
      continue;
    }
    addRoot(roots, join(workspaceRoot, "target"), "Cargo target", source);
    if (!isWithin(checkout, targetDirectory) || targetDirectory === checkout) {
      skipped.push({ path: targetDirectory, reason: `${source}; selected target directory is outside the task worktree or at its root` });
      continue;
    }
    if (cargoPackages.some(directory => isWithin(targetDirectory, directory))) {
      skipped.push({ path: targetDirectory, reason: `${source}; selected target directory contains Cargo source` });
      continue;
    }
    addRoot(roots, targetDirectory, "Cargo target", source);
  }
  return { roots, skipped, notes };
}

async function findNestedNodeModules(directory: string, skipped: SkippedRoot[]) {
  const roots = new Map<string, BuildRoot>();
  const visit = async (parent: string): Promise<void> => {
    let entries;
    try { entries = await readdir(parent, { withFileTypes: true }); }
    catch (error) { skipped.push({ path: parent, reason: `Could not inspect nested node_modules: ${error instanceof Error ? error.message : String(error)}` }); return; }
    for (const entry of entries) {
      const path = join(parent, entry.name);
      if (skippedDirectoryNames.has(entry.name)) continue;
      if (entry.name === "node_modules") { addRoot(roots, path, "node_modules"); continue; }
      if (entry.isDirectory()) await visit(path);
    }
  };
  await visit(directory);
  return [...roots.values()];
}

export interface BuildOutputCleanupOptions {
  /**
   * Run-bound settlement keeps installed dependencies (a node_modules root with
   * no Cargo target kind) so the task's next continuation can use them without
   * reinstalling. Terminal workspace cleanup never sets this.
   */
  keepDependencies?: boolean;
}

/** Remove each task-local Cargo target and node_modules root; leave an untracked canonical root symlink for checkout removal; retain and report roots whose ownership cannot be proved. */
export async function removeBuildOutput(directory: string, options: BuildOutputCleanupOptions = {}): Promise<BuildOutputCleanupResult> {
  // An absent directory has nothing to remove, and its contents cannot be read: the record settles as complete.
  if (!existsSync(directory)) return { detail: "directory absent; nothing to clean up", removed: false, safe: true };
  const checkout = resolve(directory);
  if (await realpath(checkout) !== checkout) throw new Error("Task worktree directory identity changed before build output cleanup");
  const discovery = await discoverBuildRoots(checkout);
  const removed: BuildRoot[] = [];
  const retained: string[] = [];
  const linked: BuildRoot[] = [];
  const skipped = [...discovery.skipped];
  const queue = [...discovery.roots.values()].sort((left, right) => right.path.length - left.path.length);
  const visited = new Set<string>();
  const processRoot = async (root: BuildRoot): Promise<void> => {
    if (visited.has(root.path)) return;
    visited.add(root.path);
    if (options.keepDependencies && root.kinds.size === 1 && root.kinds.has("node_modules")) {
      retained.push(root.path);
      return;
    }
    let stat;
    try { stat = await lstat(root.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      skipped.push({ path: root.path, reason: `Could not inspect build output root: ${error instanceof Error ? error.message : String(error)}${rootProvenance(root)}` });
      return;
    }
    let canonicalPath = root.path;
    // A link at the root is never resolved: its parent must be canonical and inside the checkout.
    const parent = dirname(root.path);
    if (stat.isSymbolicLink()) {
      let canonicalParent;
      try { canonicalParent = await realpath(parent); }
      catch (error) { skipped.push({ path: root.path, reason: `Could not resolve build root parent: ${error instanceof Error ? error.message : String(error)}${rootProvenance(root)}` }); return; }
      if (canonicalParent !== parent) {
        skipped.push({ path: root.path, reason: `Build output path traverses an intermediate symlink to ${join(canonicalParent, basename(root.path))}${rootProvenance(root)}` });
        return;
      }
      if (!isWithin(checkout, parent) || root.path === checkout) {
        skipped.push({ path: root.path, reason: `Build output resolves outside the task worktree or to the worktree root${rootProvenance(root)}` });
        return;
      }
    } else {
      try { canonicalPath = await realpath(root.path); }
      catch (error) { skipped.push({ path: root.path, reason: `Could not resolve build root: ${error instanceof Error ? error.message : String(error)}${rootProvenance(root)}` }); return; }
      if (canonicalPath !== root.path) {
        skipped.push({ path: root.path, reason: `Build output path traverses an intermediate symlink to ${canonicalPath}${rootProvenance(root)}` });
        return;
      }
      if (!isWithin(checkout, canonicalPath) || canonicalPath === checkout) {
        skipped.push({ path: root.path, reason: `Build output resolves outside the task worktree or to the worktree root${rootProvenance(root)}` });
        return;
      }
    }
    let tracked: string;
    const rel = relative(checkout, canonicalPath).split(sep).join("/");
    try { tracked = await defaultGit(directory, "ls-files", "--", `:(literal)${rel}`, `:(literal)${rel}/`); }
    catch (error) {
      skipped.push({ path: root.path, reason: `Could not prove the root is untracked: ${error instanceof Error ? error.message : String(error)}${rootProvenance(root)}` });
      return;
    }
    if (tracked) {
      skipped.push({ path: root.path, reason: `Git reports tracked files at or under this build root${rootProvenance(root)}` });
      if (root.kinds.has("node_modules") && stat.isDirectory() && !stat.isSymbolicLink()) {
        for (const nested of await findNestedNodeModules(root.path, skipped)) await processRoot(nested);
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      // Once a task is merged it is free to archive (Tom, 2026-10-19). An untracked link
      // at a canonical root goes with the checkout; its target stays with its owner and is
      // never followed, stat'd or cleaned. Re-observe first: a replaced entry proves nothing.
      let again;
      try { again = await lstat(root.path); }
      catch (error) { skipped.push({ path: root.path, reason: `Could not re-inspect build output symlink: ${error instanceof Error ? error.message : String(error)}${rootProvenance(root)}` }); return; }
      let parentAgain;
      try { parentAgain = await realpath(parent); } catch { parentAgain = null; }
      if (!again.isSymbolicLink() || again.dev !== stat.dev || again.ino !== stat.ino || parentAgain !== parent) {
        skipped.push({ path: root.path, reason: `Build output root changed while Queue inspected it${rootProvenance(root)}` });
        return;
      }
      linked.push(root);
      return;
    }
    if (!stat.isDirectory()) {
      skipped.push({ path: root.path, reason: `Build output root is not a directory${rootProvenance(root)}` });
      return;
    }
    try { await rm(canonicalPath, { recursive: true, force: true }); removed.push(root); }
    catch (error) { skipped.push({ path: root.path, reason: `Could not remove build output: ${error instanceof Error ? error.message : String(error)}${rootProvenance(root)}` }); }
  };
  for (const root of queue) await processRoot(root);
  const cargoRemoved = removed.filter(root => root.kinds.has("Cargo target"));
  const nodeRemoved = removed.filter(root => root.kinds.has("node_modules"));
  const details: string[] = [];
  if (cargoRemoved.length) details.push(`Removed task-local Cargo target output at ${boundedList(cargoRemoved.map(root => root.path))}`);
  if (nodeRemoved.length) details.push(`Removed node_modules at ${boundedList(nodeRemoved.map(root => root.path))}`);
  if (retained.length) details.push(`Retained node_modules at ${boundedList(retained)} for the task's next continuation`);
  if (linked.length) details.push(`Left build output symlinks: ${boundedList(linked.map(root => `${root.path} (${[...root.kinds].join(" and ")}): symlink left in place; target untouched`), "; ")}`);
  if (!removed.length && !retained.length && !linked.length) details.push("No build output roots were present");
  if (skipped.length) details.push(`Skipped build output roots: ${boundedList(skipped.map(root => `${root.path}: ${root.reason}`), "; ")}`);
  if (discovery.notes.length) details.push(`Unresolved Cargo manifests (conventional target/ only): ${boundedList(discovery.notes.map(root => `${root.path}: ${root.reason}`), "; ")}`);
  return { removed: removed.length > 0, detail: details.join(". "), safe: skipped.length === 0 };
}

/**
 * Checkout identity for a run-bound settlement: the directory still shares the
 * task repository's Git common directory. Returns the refusal, or null.
 */
export async function buildOutputCheckoutMismatch(repoPath: string, directory: string): Promise<string | null> {
  try {
    const [checkout, repository] = await Promise.all([
      defaultGit(directory, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      defaultGit(repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    ]);
    return checkout === repository ? null : "its Git common directory no longer matches the task repository";
  } catch (error) {
    return `its Git identity could not be proven: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Persist cleanup intent and its observed result across plugin restarts. The
 * terminal record is one per workspace; run-bound records (`runId`) are kept
 * alongside it and settled by the run path in the engine.
 */
export function buildOutputCleanupHooks(store: Store, taskId: string, workspaceId: string, directory: string, allowed: () => boolean, effects?: {
  intent(): void;
  observed(result: BuildOutputCleanupResult): void;
  uncertain(reason: string): void;
}): BuildOutputCleanupHooks {
  const record = (state: "intent" | "complete" | "skipped" | "uncertain", detail: string) => {
    const task = store.task(taskId);
    const at = new Date().toISOString();
    const others = task.resolution.buildOutputCleanups.filter(item => item.workspaceId !== workspaceId || item.runId);
    const prior = task.resolution.buildOutputCleanups.find(item => item.workspaceId === workspaceId && !item.runId);
    // Audit B8: an identical observation is not a new fact. The same state and detail wrote
    // a task row and an 18 KB event on every pass (4,211 rows, 74 MB, 34 distinct texts).
    // The record's time still moves when a run created after it may have regenerated output,
    // so `begin()`'s coverage test keeps meaning; a changed detail (a new or first failure)
    // and every state change are always written.
    if (prior && prior.state === state && prior.detail === detail
      && !store.runs(taskId).some(run => run.workspaceId === workspaceId && Date.parse(run.createdAt) > Date.parse(prior.at))) return;
    const withEntry = [...others, { workspaceId, directory, state, detail, at }];
    const cleanups = state === "complete" ? coverRunBuildOutput(withEntry, workspaceId, directory, at) : withEntry;
    store.update(taskId, { resolution: { ...task.resolution, buildOutputCleanups: cleanups, cleanupReason: cleanupReasonFor(task.resolution.cleanupReason, cleanups) } }, `build_output_cleanup_${state}`, `Workspace ${workspaceId}: ${detail}`);
  };
  return {
    begin() {
      const task = store.task(taskId);
      const prior = task.resolution.buildOutputCleanups.find(item => item.workspaceId === workspaceId && !item.runId);
      // A complete marker only covers output that existed when it was written. A run
      // created after it may have regenerated output, so that run must be cleaned too.
      const newerRun = prior !== undefined && store.runs(taskId).some(run => run.workspaceId === workspaceId && Date.parse(run.createdAt) > Date.parse(prior.at));
      if (prior?.state === "complete" && !newerRun) {
        effects?.observed({ detail: prior.detail, removed: false, safe: true });
        return "complete";
      }
      if (!allowed()) return false;
      if (prior?.state !== "intent") {
        record("intent", "Build output cleanup intent recorded");
      }
      effects?.intent();
      return "run";
    },
    observed(result) {
      record(result.safe ? "complete" : "skipped", result.detail);
      effects?.observed(result);
    },
    uncertain(reason) {
      record("uncertain", reason);
      effects?.uncertain(reason);
    },
  };
}
