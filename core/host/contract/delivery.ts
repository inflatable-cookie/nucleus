import type { Run, Task } from '../../../shared/contracts';

/** Delivering one message to one thread: continuation of a worker or a run under its own reporting identity, lifecycle notices, the guarded reviewer continuation, the queued send, the live-turn steer and the interrupt-and-continue. */
export interface HostDelivery {
  continueWorker?(task: Task, intentId: string, text: string, issueBinding?: () => { runId: string; token: string }): Promise<void>;
  /** Continue one retained resolution run under its existing reporting identity. */
  continueRun?(run: Run, messageId: string, text: string): Promise<void>;
  /** Deliver one idempotent task lifecycle notice to a planning thread. */
  notify?(agentId: string, messageId: string, text: string, sourceAgentId?: string): Promise<void>;
  /** One explicitly authorized reviewer delivery after fresh idle, identity and Queue-fence proofs. */
  continueReviewer?(task: Task, run: Run, messageId: string, text: string, allowed: () => Promise<boolean>, stillAllowed: () => boolean, beforeSend?: () => void): Promise<{ sent: true } | { sent: false; reason: string }>;
  /** Interrupt the active turn and deliver one continuation; used by disposition drain. */
  interruptAndContinue?(agentId: string, messageId: string, text: string): Promise<void>;
  /**
   * Queue a message behind the agent's current step. Unlike `notify` this does
   * not wait for idle, and unlike `interruptAndContinue` it does not replace
   * the live turn.
   */
  /**
   * Queue a message behind the agent's current step. Unlike `notify` this does
   * not wait for idle, and unlike `interruptAndContinue` it does not replace
   * the live turn.
   */
  enqueueMessage?(agentId: string, messageId: string, text: string, sourceAgentId?: string): Promise<void>;
  /**
   * A message to a participant (tell, relayed answer): steers into the agent's
   * live turn when one is active, otherwise delivers as `notify` does. A host
   * without steering omits it and callers fall back to `notify`. A proven
   * not-sent steer is retried once as a queued send; an unknown outcome throws
   * and is never resent.
   */
  /**
   * A message to a participant (tell, relayed answer): steers into the agent's
   * live turn when one is active, otherwise delivers as `notify` does. A host
   * without steering omits it and callers fall back to `notify`. A proven
   * not-sent steer is retried once as a queued send; an unknown outcome throws
   * and is never resent.
   */
  steerOrNotify?(agentId: string, messageId: string, text: string): Promise<void>;
  /** Stop the assigned agent's current turn without delivering a follow-up message. */
}
