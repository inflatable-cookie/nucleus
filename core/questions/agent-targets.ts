import type { Store } from "../store/store";
import type { Project, Task } from "../../shared/contracts";

/**
 * The recipient lookups both verbs share (shared/agent-verbs). A task reference
 * names a task on the board; a project names one by key or by display name. Both
 * resolve from records only: nothing here sends, observes a host or creates state.
 */

/** Resolve a task reference from a task id, a `repo#number` reference, a bare number on the sender's repository or `#number`. */
export function taskByReference(store: Store, from: Task | null, to: string): Task {
  try { return store.task(to); } catch { /* not a task id; try the reference forms */ }
  try { return store.task(store.taskIdByNumber({ reference: to })); } catch (error) {
    if (error instanceof Error && error.message.startsWith('Ambiguous task reference')) throw error;
  }
  const bare = to.match(/^#?0*([1-9][0-9]*)$/);
  if (bare && from) return store.task(store.taskIdByNumber({ repository: from.repoPath, number: Number(bare[1]) }));
  if (bare) throw Error(`A bare task number needs the sending task's repository; use a full reference such as effigy#590 or a task id`);
  throw Error(`No task matches ${JSON.stringify(to)}; use a task reference such as effigy#590, a bare number on this task's repository, or a task id`);
}

/** A project by its key or its display name; an unknown name refuses with the registered ones named. */
export function projectOfTarget(store: Store, keyOrName: string): Project {
  const wanted = keyOrName.trim();
  const project = store.projects().find(candidate => candidate.key === wanted)
    ?? store.projects().find(candidate => candidate.name.toLowerCase() === wanted.toLowerCase());
  if (project) return project;
  const known = store.projects().map(candidate => candidate.key).join(", ") || "none";
  throw Error(`No project matches ${JSON.stringify(keyOrName)}; registered projects: ${known}`);
}
