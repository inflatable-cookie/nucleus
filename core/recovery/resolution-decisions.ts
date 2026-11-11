import type { TaskStopReason } from '../../shared/task-stop';

/**
 * What one failed lifecycle pass settles as. A pass can fail because a newer
 * attempt superseded it, because a known transient fault is being paced, because
 * the daemon or forge is unavailable, because the operator's session faulted,
 * because a merge response is still uncertain, or because nothing else applies
 * and the owner must look.
 */
export type AdvanceFailureDisposition =
  | { kind: 'superseded_attempt'; successor: string }
  /** A transient git or forge fault is already recorded and paced by its handler. */
  | { kind: 'git_transient' }
  | { kind: 'wait'; reason: string; stop: TaskStopReason }
  | { kind: 'environment' }
  | { kind: 'attention'; reason: string }
  | { kind: 'merge_response_uncertain'; detail: string };
/**
 * How a failed advance settles, in today's order. `gitTransientFailure` is the
 * engine's own handler: it records the episode, so it is asked only where this
 * rule asks it, and the caller applies every other effect.
 */
export function advanceFailureDisposition(facts: {
  /** The error's message, which the disposition quotes. */
  message: string;
  /** `String(error)`, quoted where an uncertain merge response is recorded. */
  errorText: string;
  /** The run that took over, when a newer attempt superseded this one; null keeps it uncounted. */
  successor: string | null;
  mergeIntent: boolean;
  mergedCommit: string | null;
  mergeResponseOutcome: 'pending' | 'accepted' | 'uncertain' | null;
  /** An `Error` whose message says the merged PR is not the approved task's. */
  mergedIdentityDiffers: boolean;
  /** The observed run's send is still uncertain, so only evidence may settle it. */
  uncertainCurrentSend: boolean;
  /** A known transport, daemon or network fault. */
  transientSendFault: boolean;
  forgeOutage: boolean;
  gitReadTimeout: boolean;
  loginSessionFault: boolean;
}, gitTransientFailure: () => boolean): AdvanceFailureDisposition {
  // A recorded merge intent keeps its durable uncertainty whoever observes it.
  const mergeUncertain = facts.mergeIntent && !facts.mergedCommit && facts.mergeResponseOutcome === 'pending';
  if (facts.successor) return { kind: 'superseded_attempt', successor: facts.successor };
  if (!mergeUncertain && gitTransientFailure()) return { kind: 'git_transient' };
  // A failed send may have reached the retained thread. Keep that run
  // uncertain for the normal reconciliation path, but a known transient
  // daemon or network fault must not turn it into an attention episode.
  // Do not retry the send here: only observed delivery evidence can settle
  // the uncertain boundary.
  if (facts.uncertainCurrentSend && facts.transientSendFault)
    return { kind: 'wait', reason: `Transient run delivery fault; reconciling the existing run before any retry: ${facts.message}`, stop: 'external_unavailable' };
  if (facts.forgeOutage && !mergeUncertain) return { kind: 'wait', reason: facts.message, stop: 'external_unavailable' };
  if (facts.gitReadTimeout) return { kind: 'wait', reason: facts.message, stop: 'external_unavailable' };
  if (facts.loginSessionFault) return { kind: 'environment' };
  if (facts.mergeIntent && facts.mergedIdentityDiffers) return { kind: 'attention', reason: facts.message };
  if (mergeUncertain) return { kind: 'merge_response_uncertain', detail: `Initial guarded merge response is uncertain: ${facts.errorText}`.slice(0, 1500) };
  if (facts.mergeIntent && !facts.mergedCommit && facts.mergeResponseOutcome === 'uncertain')
    return { kind: 'wait', reason: 'Merge response is uncertain; GitHub reconciliation continues within the bounded proof window', stop: 'lifecycle' };
  return { kind: 'attention', reason: facts.message };
}

