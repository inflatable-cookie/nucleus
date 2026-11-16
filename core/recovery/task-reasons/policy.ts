import type { Store } from '../../store/store';
import type { Task } from '../../../shared/contracts';

/**
 * The bounded windows a lifecycle pass may answer from, the per-run keys those
 * windows are stamped under, and the repository QA shape the validation pass
 * reads. Each number here is a cost bound with a written reason, not a policy
 * knob: a reader takes it from this module instead of restating it.
 */

/** A policy observation is only usable while the settings row it read has not changed; a moving row is re-observed this many times before Queue holds visibly. */
export const MERGE_GATE_SETTINGS_ATTEMPTS = 3;
/**
 * How often the automatic external-merge probe may ask the forge about one
 * unchanged task. The probe is a control-class admission and a GitHub REST call,
 * and nothing about an unchanged run, head, PR or phase makes a repeat inside
 * this window more truthful; a changed lifecycle identity, an explicit owner
 * retry or verification path and a parked check strand each read immediately.
 */
export const EXTERNAL_MERGE_PROBE_MS = 2 * 60_000;
/** How many tasks' probe stamps are remembered; a bounded map cannot grow with history. */
export const EXTERNAL_MERGE_PROBE_LIMIT = 512;
/**
 * How long one lifecycle pass's worktree-validation scan may answer for the same
 * worktree evidence, and the hard ceiling on any shared answer (task 450).
 *
 * A `ps -A` / `lsof` scan is a bounded pass cost, not a per-read one: within one
 * pass the same worktree and selector argv are one question, so they are asked
 * once. The next pass reads again, and the contexts that decide a consequential
 * action — a recovery launch, a retained-thread revision,
 * an owner verb — ask freshly whatever else the pass has seen. `0` disables
 * sharing and reproduces the previous per-read shape in tests.
 */
export const VALIDATION_SCAN_PASS_MAX_MS = 5_000;
/** How many worktree scans one pass may keep; the map is cleared by every pass, so this only bounds a fleet-sized pass. */
export const VALIDATION_SCAN_PASS_LIMIT = 256;
/**
 * One recorded unverifiable refusal read, as `<runId>: <gap>` (papercut fe93582a). The provider-refusal
 * check is a live read whose content either proves the refusal or does not; a read that cannot settle —
 * a timeline without the run's own dispatch message (the pi provider), an unreachable older page, a gap
 * or an unreadable ordering — is never evidence, and it is not a reason to wait forever either. The
 * recorded gap is the durable count: a bounded number of reads, then the ordinary stopped-without-verdict
 * path owns the run and no further read is spent on it.
 */
export const PROVIDER_REFUSAL_UNVERIFIED = 'provider_refusal_unverified';
/** Reads of the reviewer's own timeline allowed before the ordinary path takes the run. */
export const UNVERIFIABLE_REFUSAL_READ_LIMIT = 2;
/** Durable, run-scoped proof that a reviewer refusal was seen but no eligible replacement existed yet. */
export const reviewerRefusalKey = (runId: string) => `reviewerRefusal:${runId}`;

/** The repository's configured QA argv, or nothing when it declares none. */
export function repositoryQaArgv(store: Store, task: Pick<Task, 'repoPath' | 'directory'>): string[][] {
  const row = store.repositoryFor(task.repoPath)
    ?? store.repositories().find(settings => settings.repository.path === task.repoPath || settings.repository.path === task.directory)
    ?? null;
  return qaArgvLists(row?.qa ?? null);
}

function qaArgvLists(qa: { argv?: string[]; stages?: Array<{ argv: string[] }> } | null): string[][] {
  if (!qa) return [];
  if (qa.stages?.length) return qa.stages.map(stage => stage.argv);
  return qa.argv ? [qa.argv] : [];
}
