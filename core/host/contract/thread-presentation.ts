import type { Task } from '../../../shared/contracts';

/** How a task's threads are presented to the operator and settled back: worker settlement, the attention state, support-thread settlement, the durable retries of both, and thread titles. */
export interface HostThreadPresentation {
  /**
   * One host pass opens with the tasks this host still works on. A host that keeps
   * its own thread records uses them as the pass's facts: a thread whose task is
   * over stops being observed, and every read in the pass is shared across its
   * consumers instead of paid for separately by each one. Presentation only; no
   * thread, task or delivery fact is decided here. `endHostPass` closes the pass.
   */
  beginHostPass?(tasks: readonly Task[]): Promise<void> | void;
  /** The pass closed: the next one reads afresh. */
  endHostPass?(): Promise<void> | void;
  /**
   * Settle a worker thread whose handover Nucleus accepted and moved to review
   * (#1154). Presentation only: the receipt is already durable, and an unknown
   * or refused settle never changes the task or retries blindly.
   */
  settleWorkerThread?(agentId: string, runId: string): Promise<void>;
  /**
   * Surface a stuck task's worker thread once its task needs attention
   * (#1181). Presentation only: the thread is unsettled so it shows in the
   * host's main list, and the ordinary settles put it back when the task
   * leaves attention. Unknown delivery is reconciled by re-read, never resent
   * blindly.
   */
  unsettleWorkerThread?(agentId: string, taskId: string): Promise<void>;
  /** Retry recorded worker settles during the ordinary host sweep. */
  reconcileSettledThreads?(): Promise<void>;
  /** Settle a completed support thread in hosts that expose that presentation state. */
  settleReportedThread?(agentId: string, runId: string): Promise<void>;
  /** Retry durable, uncertain report-settlement intents during the host sweep. */
  reconcileReportedSettlements?(): Promise<void>;
  /** Reconcile native thread titles from task identity during the ordinary host sweep. */
  reconcileThreadTitles?(tasks: readonly Task[]): Promise<void>;
}
