export {
  ProvenPreSendRefusalError,
  HostSnapshotPendingError,
} from '../../host/errors';

/**
 * The refusal classes an owner path throws before it writes anything, and the
 * guidance text a refused caller is answered with. A refusal is an outcome, not
 * a message to be matched: callers catch the class, never the words.
 */

/** The retained-run gate fires before retry makes any continuation changes. */
export class RetainedRunRefusal extends Error {}

export const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Round 4: the refusal for a coordinator report with no structured action, naming the exact shape. */
export function coordinatorActionShapeRefusal(why: string): string {
  return `A coordinator report needs one structured coordinatorAction object (${why}). Report again with the action in that field, not in summary text, for example `
    + `{"status":"recovered","summary":"…","coordinatorAction":{"verb":"move","to":"merge","reason":"…"}}. `
    + `Verbs: restart {role?, instruction?, fresh?}, route {role, profileId, thinkingOptionId?, now?}, move {to, instruction?}, retry_effect {effect?}, `
    + `each with reason and status recovered; or {"verb":"cannot","reason":"…"} with status blocked or error.`;
}
