import type { TaskControlInput } from "../../shared/contracts";

/**
 * Task controls that need durable serialization with lifecycle work, including
 * remote effects and disposition withdrawal, are accepted before they run.
 * Other local controls keep their synchronous behaviour because their
 * acceptance is already one short transaction.
 */
const EXTERNAL_EFFECT_ACTIONS: ReadonlySet<TaskControlInput["action"]> = new Set([ "cancel", "withdraw_cancel", "supersede",
  "complete", "restart", "move", "retry_effect", "proof",
]);
/**
 * A brief amendment with no text is a handoff instruction re-pin, which reads
 * the integration base. A route with `now` cancels a live turn, so a timed-out
 * caller must still have an operation to observe.
 */
export const controlHasExternalEffect = (input: Pick<TaskControlInput, "action" | "brief" | "now" | "force">) =>
  (EXTERNAL_EFFECT_ACTIONS.has(input.action) && !(input.action === 'retry_effect' && input.force)) || (input.action === "amend_brief" && !input.brief) || (input.action === "route" && input.now === true);
