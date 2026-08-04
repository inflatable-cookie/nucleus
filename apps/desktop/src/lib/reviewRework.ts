export type AgentChatDraftRequest = {
  requestId: number;
  projectId: string;
  taskId: string;
  text: string;
};

export const REVIEW_REWORK_PROMPT =
  "Inspect the selected task's current review feedback, then run a new rework iteration that addresses it. Leave the result awaiting review when finished.";

export function mergePreparedReworkDraft(current: string, prepared: string): string {
  if (!current.trim()) return prepared;
  if (current.includes(prepared)) return current;
  return `${current}\n\n${prepared}`;
}
