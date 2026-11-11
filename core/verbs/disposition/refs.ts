import { existsSync } from "node:fs";
import type { DispositionRef, PostDispositionRef, Task } from "../../../shared/contracts";
import { now, type Store } from "../../store/store";
import { git } from "../../git/index";
import type { DispositionDeps } from "./types";
import { setDisposition } from "./state";

export function parseLsRemote(output: string): DispositionRef[] {
  const refs: DispositionRef[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^([a-f0-9]{40})\s+(\S+)$/);
    if (!match || match[2].endsWith("^{}")) continue;
    refs.push({ sha: match[1], ref: match[2] });
  }
  return refs;
}

/** Origin heads and tags. Missing cwd is empty success; a git failure throws so the snapshot is not stored as empty. */
export async function listOriginRefs(task: Task): Promise<DispositionRef[]> {
  const cwd = task.directory && existsSync(task.directory) ? task.directory
    : task.repoPath && existsSync(task.repoPath) ? task.repoPath : "";
  if (!cwd) return [];
  return parseLsRemote(await git(cwd, "ls-remote", "--heads", "--tags", "origin"));
}

function watchedDispositionRef(ref: string, branch: string): boolean {
  return ref === `refs/heads/${branch}` || ref.startsWith("refs/tags/");
}

export function postDispositionRefDiff(
  snapshot: DispositionRef[], listed: DispositionRef[], branch: string, already: PostDispositionRef[], observedAt: string,
): PostDispositionRef[] {
  const baseline = new Map(snapshot.map(item => [item.ref, item.sha]));
  const known = new Map(already.map(item => [item.ref, item.sha]));
  const found: PostDispositionRef[] = [];
  for (const item of listed) {
    if (!watchedDispositionRef(item.ref, branch)) continue;
    if (baseline.get(item.ref) === item.sha) continue;
    if (known.get(item.ref) === item.sha) continue;
    found.push({ ...item, observedAt });
  }
  return found;
}

export async function snapshotOriginRefs(store: Store, deps: DispositionDeps, taskId: string): Promise<void> {
  const task = store.task(taskId);
  if (!task.disposition || task.disposition.refSnapshot !== null) return;
  if (!deps.listRemoteRefs) {
    setDisposition(store, task, { ...task.disposition, refSnapshot: [] }, "disposition_ref_snapshot", "Origin ref listing is unavailable; snapshot empty");
    return;
  }
  try {
    const refs = await deps.listRemoteRefs(task);
    setDisposition(store, store.task(taskId), { ...store.task(taskId).disposition!, refSnapshot: refs },
      "disposition_ref_snapshot", `${refs.length} origin refs`);
  } catch (error) {
    store.event(taskId, "disposition_ref_snapshot_failed", error instanceof Error ? error.message : String(error));
  }
}

export async function observePostDispositionRefs(store: Store, deps: DispositionDeps, taskId: string): Promise<void> {
  const task = store.task(taskId);
  if (!task.disposition || task.disposition.refSnapshot === null || !deps.listRemoteRefs) return;
  const snapshot = task.disposition.refSnapshot;
  let listed: DispositionRef[];
  try { listed = await deps.listRemoteRefs(task); }
  catch (error) {
    store.event(taskId, "disposition_ref_observe_failed", error instanceof Error ? error.message : String(error));
    return;
  }
  const found = postDispositionRefDiff(snapshot, listed, task.branch, task.disposition.postDispositionRefs, now());
  if (!found.length) return;
  const postDispositionRefs = [...task.disposition.postDispositionRefs.filter(item => !found.some(next => next.ref === item.ref)), ...found];
  setDisposition(store, store.task(taskId), { ...store.task(taskId).disposition!, postDispositionRefs },
    "disposition_post_ref", found.map(item => `${item.ref} ${item.sha}`).join("; "));
}
