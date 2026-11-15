/**
 * Task 405: the refusal vocabulary of the source-immutable author-side proof
 * executor. One error type carries a code, the invariant it broke and whether a
 * retry could clear it, so no caller has to read the message to know what
 * happened.
 */
export type ProofExecutionRefusalCode =
  | 'no_brief_subject'
  | 'allowance_spent'
  | 'not_authorized'
  | 'source_unavailable'
  | 'source_moved'
  | 'source_dirty'
  | 'source_branch'
  | 'live_run'
  | 'dispatch_held'
  | 'paused'
  | 'wrong_phase'
  | 'wrong_pr';

/** A typed refusal with the invariant and the verb that clears it. */
export class ProofExecutionRefusal extends Error {
  constructor(readonly code: ProofExecutionRefusalCode, message: string, readonly transient = false) {
    super(message);
    this.name = 'ProofExecutionRefusal';
  }
}

export const refuseProof = (code: ProofExecutionRefusalCode, message: string, transient = false): never => {
  throw new ProofExecutionRefusal(code, message, transient);
};
