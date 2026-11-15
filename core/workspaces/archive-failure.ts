/**
 * The one classification of a failed archive attempt.
 *
 * A Queue-authored refusal states the stage it failed at, so no caller reads its
 * message text: `WorkspaceTeardownRefusal` and any other staged refusal carry an
 * `archiveFailureStage`. A teardown refusal keeps the captured runtime scope so
 * the retirement proof is retried with its own token; a Queue-authored refusal
 * at another stage (a hold, a foreign thread, a source proof) must not touch it.
 *
 * A *foreign* failure — a host error, a wrapped transport failure, a runtime
 * retirement program's own error — carries no stage, and its prose is then the
 * only fact it offers. That compatibility path lives here and nowhere else.
 * Every archive path asks this module, so the classification cannot drift between
 * the terminal archive, the owner retry and unused-workspace cleanup.
 */
export interface ArchiveFailureScope {
  hasScope(taskId: string, workspaceId: string): boolean;
}

/** The stage an archive attempt failed at, as its Queue-authored producer knows it. */
export type ArchiveFailureStage = "teardown" | "other";

/** A Queue-authored archive refusal that states its stage instead of relying on its message. */
export interface StagedArchiveFailure {
  readonly archiveFailureStage: ArchiveFailureStage;
}

/** The typed stage of a Queue-authored refusal, or null for a foreign failure. */
export function archiveFailureStage(error: unknown): ArchiveFailureStage | null {
  if (!error || typeof error !== "object") return null;
  const stage = (error as Partial<StagedArchiveFailure>).archiveFailureStage;
  return stage === "teardown" || stage === "other" ? stage : null;
}

export function archiveFailureKeepsScope(scope: ArchiveFailureScope, taskId: string, workspaceId: string, error: unknown): boolean {
  const stage = archiveFailureStage(error);
  if (stage) return stage === "teardown";
  const detail = archiveFailureDetail(error);
  return /teardown/i.test(detail) || (scope.hasScope(taskId, workspaceId) && /retire|runtime scope/i.test(detail));
}

/**
 * Whether an uncertain archive's failure names a teardown or retirement attempt
 * at all: the typed stage when the refusal states one, else a foreign failure's
 * own words.
 */
export function archiveFailureIsTeardown(error: unknown): boolean {
  const stage = archiveFailureStage(error);
  if (stage) return stage === "teardown";
  return /teardown|retire|runtime scope/i.test(archiveFailureDetail(error));
}

function archiveFailureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
