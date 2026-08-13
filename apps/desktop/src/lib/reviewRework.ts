export type AgentChatDraftRequest = {
  requestId: number;
  projectId: string;
  /** Task-scoped rework draft target; null when the draft is run-scoped. */
  taskId: string | null;
  /** Run-scoped rework draft target: the run conversation id. When set, the
   * draft applies to that conversation regardless of the active task. */
  runConversationId: string | null;
  text: string;
};

export const REVIEW_REWORK_PROMPT =
  "Inspect the selected task's current review feedback, then run a new rework iteration that addresses it. Leave the result awaiting review when finished.";

export const RUN_REWORK_PROMPT =
  "Inspect this run's delivery review feedback (the closeout and the rejected disposition), then run a new rework iteration in this worktree that addresses it. Leave the result delivered and awaiting review when finished.";

export function mergePreparedReworkDraft(current: string, prepared: string): string {
  if (!current.trim()) return prepared;
  if (current.includes(prepared)) return current;
  return `${current}\n\n${prepared}`;
}
